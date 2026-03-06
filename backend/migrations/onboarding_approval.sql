-- ================================================================
-- GullyBite — Onboarding & Manual Approval fields
-- Run in: Supabase Dashboard → SQL Editor
-- ================================================================

-- ── NEW COLUMNS ON restaurants ──────────────────────────────────
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS brand_name VARCHAR(255);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS registered_business_name VARCHAR(255);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS gst_number VARCHAR(20);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS fssai_license VARCHAR(50);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS fssai_expiry DATE;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS restaurant_type VARCHAR(20) DEFAULT 'both'
  CHECK (restaurant_type IN ('veg','non_veg','both'));

-- approval_status tracks the manual review gate:
--   pending  → application submitted, awaiting admin review
--   approved → admin approved, restaurant can access dashboard
--   rejected → admin rejected, shown reason in UI
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending'
  CHECK (approval_status IN ('pending','approved','rejected'));
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS approval_notes TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

-- Existing active restaurants are already approved — don't lock them out
UPDATE restaurants SET approval_status = 'approved' WHERE status = 'active';

-- Index for fast admin queries
CREATE INDEX IF NOT EXISTS idx_restaurants_approval
  ON restaurants(approval_status, submitted_at DESC);

DO $$ BEGIN
  RAISE NOTICE '✅ Onboarding & approval migration complete';
  RAISE NOTICE '   All existing active restaurants set to approved';
END $$;
