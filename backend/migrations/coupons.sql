-- ================================================================
-- GullyBite — Coupons / Discount System
-- Restaurants create coupon codes; applied during WhatsApp checkout
-- Run in: Supabase Dashboard → SQL Editor
-- ================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── COUPONS TABLE ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coupons (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  code            VARCHAR(50) NOT NULL,    -- e.g. WELCOME20, FLAT50
  description     TEXT,                    -- shown to customer e.g. "20% off on orders above ₹300"

  -- Discount logic
  discount_type   VARCHAR(20) NOT NULL
                  CHECK (discount_type IN ('percent', 'flat')),
  discount_value  DECIMAL(10,2) NOT NULL,  -- 20 for 20%, or 50 for ₹50 flat
  min_order_rs    DECIMAL(10,2) DEFAULT 0, -- minimum subtotal to apply coupon
  max_discount_rs DECIMAL(10,2),           -- cap for percent coupons (NULL = no cap)

  -- Usage limits
  usage_limit     INT,                     -- NULL = unlimited
  used_count      INT DEFAULT 0,

  -- Validity window (NULL = no restriction)
  valid_from      DATE,
  valid_until     DATE,

  is_active       BOOLEAN DEFAULT TRUE,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  -- Code must be unique per restaurant (same code can exist on different restaurants)
  UNIQUE (restaurant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_coupons_restaurant
  ON coupons(restaurant_id, is_active);

-- ── ADD COUPON TRACKING TO ORDERS ───────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_id   UUID REFERENCES coupons(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(50);
-- Note: discount_rs already exists on orders from the base schema

DO $$ BEGIN
  RAISE NOTICE '✅ Coupons migration complete';
  RAISE NOTICE '   Table: coupons';
  RAISE NOTICE '   Orders: coupon_id + coupon_code columns added';
  RAISE NOTICE '   Coupon types: percent (with optional cap) and flat (fixed Rs off)';
END $$;
