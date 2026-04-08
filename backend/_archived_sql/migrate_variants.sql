-- ================================================================
-- Migration: Add product variants + branch catalog columns
-- Run with: psql $DATABASE_URL -f src/models/migrate_variants.sql
-- Safe to run multiple times (uses IF NOT EXISTS / IF EXISTS checks)
-- ================================================================

-- ── branches: add catalog columns (were missing from original schema) ──
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS catalog_id        VARCHAR(255),
  ADD COLUMN IF NOT EXISTS catalog_synced_at TIMESTAMPTZ;

-- ── menu_items: add variant columns ───────────────────────────────────
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS item_group_id  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS variant_type   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS variant_value  VARCHAR(100);

-- ── index for fast variant-group lookups ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_menu_items_group
  ON menu_items(item_group_id) WHERE item_group_id IS NOT NULL;

DO $$ BEGIN RAISE NOTICE 'Migration complete: variants + branch catalog columns added.'; END $$;
