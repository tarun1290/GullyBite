-- ================================================================
-- GullyBite — Referrals System
-- 7.5% referral fee on orders placed by customers referred by admin
-- Referral attribution window: 8 hours from creation
-- Run in: Supabase Dashboard → SQL Editor
-- ================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── REFERRALS TABLE ──────────────────────────────────────────────
-- Created by admin when they send a restaurant's WA link to a customer.
-- If that customer places an order within 8 hours, it's tagged as referred.
CREATE TABLE IF NOT EXISTS referrals (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id        UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  -- Customer the admin is referring
  customer_wa_phone    VARCHAR(30) NOT NULL,
  customer_name        VARCHAR(255),

  -- Unique short code, used to identify this referral
  referral_code        VARCHAR(50) UNIQUE NOT NULL
                       DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),

  -- active   → within 8h window, no order yet
  -- converted → at least one order placed within window
  -- expired  → 8h passed, no order placed
  status               VARCHAR(20) DEFAULT 'active'
                       CHECK (status IN ('active','converted','expired')),

  expires_at           TIMESTAMPTZ NOT NULL,   -- created_at + 8 hours

  -- Running totals (updated each time a referred order is placed)
  orders_count         INT DEFAULT 0,
  total_order_value_rs DECIMAL(10,2) DEFAULT 0,
  referral_fee_rs      DECIMAL(10,2) DEFAULT 0,  -- 7.5% of total_order_value_rs

  notes                TEXT,   -- optional note from admin

  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Fast lookup when an order comes in: is this customer referred?
CREATE INDEX IF NOT EXISTS idx_referrals_active_lookup
  ON referrals(restaurant_id, customer_wa_phone, expires_at)
  WHERE status = 'active';

-- ── ADD REFERRAL COLUMNS TO ORDERS ──────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_id     UUID REFERENCES referrals(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_fee_rs DECIMAL(10,2) DEFAULT 0;

-- ── EXPIRE OLD REFERRALS (run periodically or inline) ───────────
-- Can be called manually or via a cron job:
-- UPDATE referrals SET status='expired', updated_at=NOW()
-- WHERE status='active' AND expires_at < NOW();

DO $$ BEGIN
  RAISE NOTICE '✅ Referrals migration complete';
  RAISE NOTICE '   Table: referrals';
  RAISE NOTICE '   Orders: referral_id + referral_fee_rs columns added';
  RAISE NOTICE '   Referral fee: 7.5%% of order subtotal';
  RAISE NOTICE '   Attribution window: 8 hours';
END $$;
