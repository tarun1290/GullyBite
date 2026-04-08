-- ================================================================
-- GullyBite — Restaurant Charge Configuration
-- Adds delivery fee split, menu GST mode, and packaging charges
-- to the restaurants table, and charge breakdown columns to orders.
-- Run in: Supabase Dashboard → SQL Editor
-- ================================================================

-- ── RESTAURANTS: charge config columns ───────────────────────────

ALTER TABLE restaurants
  -- % of delivery fee that the CUSTOMER pays (0-100, default 100 = customer pays all)
  ADD COLUMN IF NOT EXISTS delivery_fee_customer_pct  INT          NOT NULL DEFAULT 100
    CHECK (delivery_fee_customer_pct BETWEEN 0 AND 100),

  -- How menu prices are quoted w.r.t. food GST
  -- 'included' → 5% GST is already inside the listed price (no extra line)
  -- 'extra'    → 5% GST is charged on top of the listed price at checkout
  ADD COLUMN IF NOT EXISTS menu_gst_mode              VARCHAR(20)  NOT NULL DEFAULT 'included'
    CHECK (menu_gst_mode IN ('included', 'extra')),

  -- Food GST % (default 5 — standard rate for restaurants)
  ADD COLUMN IF NOT EXISTS menu_gst_pct               DECIMAL(5,2) NOT NULL DEFAULT 5.00,

  -- Fixed packaging charge per order (INR, 0 = disabled)
  ADD COLUMN IF NOT EXISTS packaging_charge_rs        DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- GST % levied on packaging charge (default 18)
  ADD COLUMN IF NOT EXISTS packaging_gst_pct          DECIMAL(5,2)  NOT NULL DEFAULT 18.00;

-- ── ORDERS: per-order charge breakdown columns ───────────────────

ALTER TABLE orders
  -- Food GST charged to customer (0 when menu_gst_mode = 'included')
  ADD COLUMN IF NOT EXISTS food_gst_rs                DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- Full delivery fee before split
  ADD COLUMN IF NOT EXISTS delivery_fee_total_rs      DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- Customer's share of delivery fee (ex-GST)
  ADD COLUMN IF NOT EXISTS customer_delivery_rs       DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- 18% GST on customer's delivery share
  ADD COLUMN IF NOT EXISTS customer_delivery_gst_rs   DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- Restaurant's share of delivery fee (ex-GST) — deducted at settlement
  ADD COLUMN IF NOT EXISTS restaurant_delivery_rs     DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- 18% GST on restaurant's delivery share — deducted at settlement
  ADD COLUMN IF NOT EXISTS restaurant_delivery_gst_rs DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- Packaging charge (ex-GST)
  ADD COLUMN IF NOT EXISTS packaging_rs               DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- GST on packaging charge
  ADD COLUMN IF NOT EXISTS packaging_gst_rs           DECIMAL(10,2) NOT NULL DEFAULT 0.00;

-- ── CONVENIENCE VIEW: order charge summary ───────────────────────
-- What the customer actually pays vs what the restaurant keeps/owes.
CREATE OR REPLACE VIEW order_charge_summary AS
SELECT
  o.id                                                          AS order_id,
  b.restaurant_id,
  o.subtotal_rs,
  o.food_gst_rs,
  o.customer_delivery_rs,
  o.customer_delivery_gst_rs,
  o.packaging_rs,
  o.packaging_gst_rs,
  o.discount_rs,
  -- Total amount billed to customer
  (o.subtotal_rs
   + COALESCE(o.food_gst_rs, 0)
   + COALESCE(o.customer_delivery_rs, 0) + COALESCE(o.customer_delivery_gst_rs, 0)
   + COALESCE(o.packaging_rs, 0)        + COALESCE(o.packaging_gst_rs, 0)
   - COALESCE(o.discount_rs, 0))                               AS customer_total_rs,
  -- Deductions from restaurant's payout
  (COALESCE(o.restaurant_delivery_rs, 0) + COALESCE(o.restaurant_delivery_gst_rs, 0)) AS restaurant_delivery_deduction_rs,
  -- Platform fee (fixed monthly, stored per-order as 0)
  COALESCE(o.platform_fee_rs, 0)                               AS platform_commission_rs,
  -- Net payout to restaurant
  (o.subtotal_rs
   - COALESCE(o.discount_rs, 0)
   - COALESCE(o.restaurant_delivery_rs, 0) - COALESCE(o.restaurant_delivery_gst_rs, 0)
   - COALESCE(o.platform_fee_rs, 0))                          AS restaurant_net_rs
FROM orders o
JOIN branches b ON o.branch_id = b.id;

DO $$ BEGIN
  RAISE NOTICE '✅ Restaurant charges migration complete';
  RAISE NOTICE '   restaurants: delivery_fee_customer_pct, menu_gst_mode, menu_gst_pct, packaging_charge_rs, packaging_gst_pct';
  RAISE NOTICE '   orders: food_gst_rs, delivery_fee_total_rs, customer_delivery_rs, customer_delivery_gst_rs,';
  RAISE NOTICE '           restaurant_delivery_rs, restaurant_delivery_gst_rs, packaging_rs, packaging_gst_rs';
  RAISE NOTICE '   view: order_charge_summary';
END $$;
