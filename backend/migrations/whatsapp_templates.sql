-- ================================================================
-- GullyBite — WhatsApp Template Mappings
-- Restaurants map approved Meta message templates to order events.
-- Variables in templates ({{1}}, {{2}}…) are bound to known order fields.
-- Run in: Supabase Dashboard → SQL Editor
-- ================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── TEMPLATE MAPPINGS TABLE ──────────────────────────────────────
-- Each row: restaurant + event → which approved Meta template to use
CREATE TABLE IF NOT EXISTS whatsapp_template_mappings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  -- The order lifecycle event this mapping applies to
  event_name        VARCHAR(50) NOT NULL
                    CHECK (event_name IN ('CONFIRMED','PREPARING','PACKED','DISPATCHED','DELIVERED','CANCELLED')),

  -- Meta template fields (must match an approved template in the WABA)
  template_name     VARCHAR(512) NOT NULL,
  template_language VARCHAR(20)  NOT NULL DEFAULT 'en',

  -- Maps template variable positions to known order data fields.
  -- e.g. {"1": "order_number", "2": "total_rs", "3": "eta"}
  -- Supported field names: order_number, customer_name, total_rs,
  --   branch_name, restaurant_name, eta, tracking_url
  variable_map      JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (restaurant_id, event_name)
);

CREATE INDEX IF NOT EXISTS idx_wa_tmpl_mappings_restaurant
  ON whatsapp_template_mappings(restaurant_id);

DO $$ BEGIN
  RAISE NOTICE '✅ WhatsApp template mappings migration complete';
  RAISE NOTICE '   Table: whatsapp_template_mappings';
  RAISE NOTICE '   Supported events: CONFIRMED, PREPARING, PACKED, DISPATCHED, DELIVERED, CANCELLED';
  RAISE NOTICE '   Variable fields: order_number, customer_name, total_rs, branch_name, restaurant_name, eta, tracking_url';
END $$;
