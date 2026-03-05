-- ================================================================
-- GullyBite — Complete Database Schema
-- Run this with: npm run db:setup
-- Or manually:  psql $DATABASE_URL -f src/models/schema.sql
-- ================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ────────────────────────────────────────────────────────────────
-- RESTAURANTS
-- One row per restaurant business that signs up on GullyBite.
-- Created when a restaurant owner completes Meta OAuth.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurants (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Basic business info filled during onboarding
  business_name         VARCHAR(255) NOT NULL DEFAULT 'My Restaurant',
  owner_name            VARCHAR(255),
  email                 VARCHAR(255) UNIQUE,
  phone                 VARCHAR(30),
  logo_url              TEXT,

  -- Meta OAuth credentials
  -- These are stored after the restaurant owner connects via Facebook Login
  meta_user_id          VARCHAR(255) UNIQUE,
  meta_access_token     TEXT,               -- 60-day token from OAuth
  meta_token_expires_at TIMESTAMPTZ,

  -- Bank account for weekly payouts
  bank_name             VARCHAR(255),
  bank_account_number   VARCHAR(50),
  bank_ifsc             VARCHAR(20),
  razorpay_fund_acct_id VARCHAR(100),       -- Razorpay fund account for payouts

  -- Platform settings per restaurant
  commission_pct        DECIMAL(5,2) DEFAULT 10.00,

  -- Future integrations (kept as comments for now)
  -- zomato_restaurant_id  VARCHAR(100),
  -- zomato_access_token   TEXT,
  -- petpooja_outlet_id    VARCHAR(100),
  -- petpooja_api_key      TEXT,

  status                VARCHAR(20) DEFAULT 'active'
                        CHECK (status IN ('active','suspended','pending')),
  onboarding_step       INT DEFAULT 1,  -- 1=signup, 2=profile, 3=branch, 4=menu, 5=live

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- WHATSAPP ACCOUNTS
-- Each restaurant connects one WhatsApp Business number.
-- Stores the phone number ID used to send/receive messages.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  -- IDs from Meta Developer Console
  waba_id         VARCHAR(255),           -- WhatsApp Business Account ID
  phone_number_id VARCHAR(255) UNIQUE NOT NULL,  -- ID of the phone number
  phone_display   VARCHAR(30),            -- Human-readable: +91 98765 43210
  display_name    VARCHAR(255),           -- Business name shown in WhatsApp

  -- Catalog ID for WhatsApp in-app shopping
  -- Create catalog in: business.facebook.com → Catalog Manager
  catalog_id      VARCHAR(255),
  catalog_synced_at TIMESTAMPTZ,

  -- Message quality metrics from Meta
  quality_rating  VARCHAR(20) DEFAULT 'GREEN',  -- GREEN / YELLOW / RED
  messaging_limit VARCHAR(50),                   -- Messages per day limit

  -- Access token for this number (system user token)
  access_token    TEXT,

  -- Future integrations (kept as comments)
  -- zomato_menu_url TEXT,
  -- petpooja_sync_status VARCHAR(20),

  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- BRANCHES
-- Physical restaurant locations. Each has GPS coordinates.
-- When a customer shares location, we find the nearest branch.
-- That branch's menu is shown as the WhatsApp Catalog.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id      UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  name               VARCHAR(255) NOT NULL,   -- e.g. "Koramangala Outlet"
  address            TEXT,
  city               VARCHAR(100),
  pincode            VARCHAR(10),

  -- GPS coordinates: CRITICAL for nearest-branch matching
  -- Get from Google Maps: right-click any spot → copy lat,lng
  latitude           DECIMAL(10,8) NOT NULL,  -- e.g. 12.93456789
  longitude          DECIMAL(11,8) NOT NULL,  -- e.g. 77.61234567

  -- How far from this branch we'll accept delivery orders
  delivery_radius_km DECIMAL(6,2) DEFAULT 5.0,

  -- Operating hours
  opening_time       TIME DEFAULT '10:00:00',
  closing_time       TIME DEFAULT '22:00:00',

  is_open            BOOLEAN DEFAULT TRUE,
  accepts_orders     BOOLEAN DEFAULT TRUE,
  manager_phone      VARCHAR(30),

  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- MENU CATEGORIES
-- e.g. Starters, Main Course, Desserts, Beverages
-- Each branch has its own categories
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id   UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  sort_order  INT DEFAULT 0,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- MENU ITEMS
-- Individual dishes. These get synced to WhatsApp Catalog API.
-- Price stored in paise (1 rupee = 100 paise) to avoid decimal bugs.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_items (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id      UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  category_id    UUID REFERENCES menu_categories(id),

  name           VARCHAR(255) NOT NULL,
  description    TEXT,
  price_paise    INT NOT NULL,          -- e.g. Rs 280 = 28000 paise

  -- This is what Meta uses to identify items in WhatsApp orders
  -- Must be unique across your entire catalog
  retailer_id    VARCHAR(255) UNIQUE,   -- Your internal SKU

  image_url      TEXT,                  -- Must be public HTTPS URL

  food_type      VARCHAR(20) DEFAULT 'veg'
                 CHECK (food_type IN ('veg','non_veg','vegan','egg')),

  is_available   BOOLEAN DEFAULT TRUE,
  is_bestseller  BOOLEAN DEFAULT FALSE,
  sort_order     INT DEFAULT 0,

  -- Optional: customizations like size, add-ons
  -- Format: [{"name":"Size","options":["Half","Full"],"prices":[0,50]}]
  customizations JSONB DEFAULT '[]',

  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- CUSTOMERS
-- Auto-created when someone first messages any restaurant's WhatsApp.
-- No signup needed from the customer's side!
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- WhatsApp phone number with country code but NO plus sign
  -- e.g. 919876543210 for Indian number +91 98765 43210
  wa_phone        VARCHAR(30) UNIQUE NOT NULL,

  name            VARCHAR(255),      -- From WhatsApp profile name

  -- Last known delivery location (updated each order)
  last_lat        DECIMAL(10,8),
  last_lng        DECIMAL(11,8),
  last_address    TEXT,

  -- Lifetime stats for analytics
  total_orders    INT DEFAULT 0,
  total_spent_rs  DECIMAL(12,2) DEFAULT 0,
  last_order_at   TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- CONVERSATIONS
-- The BRAIN of the WhatsApp bot.
-- Tracks current state per customer per WhatsApp number.
-- e.g. "This customer is at the AWAITING_PAYMENT step for this restaurant"
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id     UUID NOT NULL REFERENCES customers(id),
  wa_account_id   UUID NOT NULL REFERENCES whatsapp_accounts(id),

  -- Current position in the bot flow
  -- GREETING → AWAITING_LOCATION → SHOWING_CATALOG →
  -- ORDER_REVIEW → AWAITING_PAYMENT → ORDER_ACTIVE → COMPLETED
  state           VARCHAR(50) NOT NULL DEFAULT 'GREETING',

  -- Temporary data for this session stored as JSON
  -- We store: selected branch_id, cart items, order_number, etc.
  -- Using JSONB so we don't need to add columns for each piece of data
  session_data    JSONB DEFAULT '{}',

  active_order_id UUID,  -- Set once order is created

  -- Track when customer last sent us a message
  -- Meta allows free-form replies within 24hrs of last customer message
  last_msg_at     TIMESTAMPTZ DEFAULT NOW(),

  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Only one active conversation per customer per WA number
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_conv
  ON conversations(customer_id, wa_account_id)
  WHERE is_active = TRUE;

-- ────────────────────────────────────────────────────────────────
-- ORDERS
-- Created when customer confirms cart and hits "Confirm & Pay"
-- Tracks full lifecycle from PENDING_PAYMENT to DELIVERED
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Human-readable ID for display (e.g. ZM-20240915-0001)
  order_number    VARCHAR(50) UNIQUE NOT NULL,

  customer_id     UUID NOT NULL REFERENCES customers(id),
  branch_id       UUID NOT NULL REFERENCES branches(id),
  conversation_id UUID REFERENCES conversations(id),

  -- Financials (in rupees, 2 decimal places)
  subtotal_rs     DECIMAL(10,2) NOT NULL,
  delivery_fee_rs DECIMAL(10,2) DEFAULT 40,
  discount_rs     DECIMAL(10,2) DEFAULT 0,
  total_rs        DECIMAL(10,2) NOT NULL,
  platform_fee_rs DECIMAL(10,2) DEFAULT 0,

  -- Delivery details at time of order
  delivery_address TEXT,
  delivery_lat    DECIMAL(10,8),
  delivery_lng    DECIMAL(11,8),

  -- Order lifecycle
  -- PENDING_PAYMENT → PAID → CONFIRMED → PREPARING → PACKED
  -- → DISPATCHED → DELIVERED  (or CANCELLED / REFUNDED)
  status          VARCHAR(30) NOT NULL DEFAULT 'PENDING_PAYMENT',

  -- Timestamps for each status change
  paid_at         TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ,
  preparing_at    TIMESTAMPTZ,
  packed_at       TIMESTAMPTZ,
  dispatched_at   TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,

  -- Settlement tracking
  settlement_id   UUID,
  settled_at      TIMESTAMPTZ,

  special_notes   TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- ORDER ITEMS
-- Line items per order. We snapshot the price/name at order time
-- so price changes later don't affect historical orders.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id    UUID REFERENCES menu_items(id),  -- NULL if item deleted

  -- Snapshot at time of order
  item_name       VARCHAR(255) NOT NULL,
  unit_price_rs   DECIMAL(10,2) NOT NULL,
  quantity        INT NOT NULL CHECK (quantity > 0),
  line_total_rs   DECIMAL(10,2) NOT NULL,

  -- Selected customizations e.g. {"Size":"Full","Extra Cheese":"Yes"}
  customizations  JSONB DEFAULT '{}',

  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- PAYMENTS
-- Razorpay payment link records.
-- One payment link per order.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id),

  -- Razorpay IDs
  rp_link_id      VARCHAR(255) UNIQUE,  -- plink_xxxxxxxx
  rp_link_url     TEXT,                 -- Short URL sent to customer
  rp_payment_id   VARCHAR(255),         -- pay_xxxxxxxx (after successful payment)
  rp_order_id     VARCHAR(255),         -- order_xxxxxxxx

  amount_rs       DECIMAL(10,2) NOT NULL,
  currency        VARCHAR(5) DEFAULT 'INR',

  -- created → sent → paid / failed / expired
  status          VARCHAR(30) DEFAULT 'created',

  payment_method  VARCHAR(50),     -- upi / card / netbanking / wallet
  expires_at      TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- DELIVERIES  (3PL - commented features, table structure ready)
-- Will be used when 3PL integration is enabled
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deliveries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID NOT NULL REFERENCES orders(id),

  -- 3PL provider details (commented until integrated)
  -- provider            VARCHAR(50),   -- 'dunzo' / 'borzo' / 'shadowfax'
  -- provider_order_id   VARCHAR(255),
  -- tracking_url        TEXT,
  -- driver_name         VARCHAR(255),
  -- driver_phone        VARCHAR(30),
  -- driver_lat          DECIMAL(10,8),
  -- driver_lng          DECIMAL(11,8),

  status          VARCHAR(30) DEFAULT 'pending',
  estimated_mins  INT,
  picked_up_at    TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  cost_rs         DECIMAL(10,2) DEFAULT 0,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- SETTLEMENTS
-- Weekly payout records. Cron job runs every Monday.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settlements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),

  period_start    DATE NOT NULL,   -- e.g. 2024-09-09
  period_end      DATE NOT NULL,   -- e.g. 2024-09-15

  -- Financials breakdown
  gross_revenue_rs   DECIMAL(12,2) DEFAULT 0,
  platform_fee_rs    DECIMAL(12,2) DEFAULT 0,
  delivery_costs_rs  DECIMAL(12,2) DEFAULT 0,
  refunds_rs         DECIMAL(12,2) DEFAULT 0,
  net_payout_rs      DECIMAL(12,2) DEFAULT 0,

  orders_count    INT DEFAULT 0,

  -- Payout tracking
  -- pending → processing → completed / failed
  payout_status   VARCHAR(30) DEFAULT 'pending',
  rp_payout_id    VARCHAR(255),   -- Razorpay payout ID
  payout_at       TIMESTAMPTZ,

  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- WEBHOOK LOGS
-- Store EVERY incoming webhook payload for debugging and future analytics.
-- This raw data is invaluable for ML models and business intelligence.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Which system sent this webhook
  source        VARCHAR(30) NOT NULL,  -- 'whatsapp' / 'razorpay' / '3pl'

  -- What type of event
  event_type    VARCHAR(100),          -- e.g. 'messages', 'payment.captured'

  -- The phone number that received this (for WhatsApp webhooks)
  phone_number_id VARCHAR(255),

  -- Full raw payload - never throw this away!
  payload       JSONB NOT NULL,

  -- Processing status
  processed     BOOLEAN DEFAULT FALSE,
  error_message TEXT,

  received_at   TIMESTAMPTZ DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

-- ────────────────────────────────────────────────────────────────
-- PERFORMANCE INDEXES
-- These speed up common queries
-- ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_conversations_lookup
  ON conversations(customer_id, wa_account_id, is_active);

CREATE INDEX IF NOT EXISTS idx_orders_branch
  ON orders(branch_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_customer
  ON orders(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_menu_items_branch
  ON menu_items(branch_id, is_available, sort_order);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_source
  ON webhook_logs(source, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_order
  ON payments(order_id, status);

-- ────────────────────────────────────────────────────────────────
-- AUTO-UPDATE updated_at on every UPDATE
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'restaurants','whatsapp_accounts','branches','menu_items',
    'customers','conversations','orders','payments','deliveries'
  ] LOOP
    EXECUTE format('
      DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I;
      CREATE TRIGGER trg_%I_updated_at
        BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
    ', t, t, t, t);
  END LOOP;
END $$;

-- Done!
DO $$ BEGIN RAISE NOTICE '✅ GullyBite schema created successfully!'; END $$;