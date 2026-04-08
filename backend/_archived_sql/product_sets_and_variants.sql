-- Migration: Product Sets (category grouping) + Variant support
-- Run in Supabase SQL editor after restaurant_integrations.sql

-- ── 1. Product Sets ───────────────────────────────────────────────
-- Stores the Meta product_set_id per category so we can update it on re-sync
-- instead of creating duplicates in Commerce Manager.
ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS meta_set_id TEXT;

-- ── 2. Variant columns on menu_items ─────────────────────────────
-- item_group_id : shared UUID across all variants of the same dish
--                 e.g. "butter-chicken-koramangala-abc123"
-- variant_type  : 'size' | 'portion' | 'spice_level' (Meta maps 'size' natively)
-- variant_value : 'Small' | 'Regular' | 'Large' | 'Half' | 'Full' etc.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS item_group_id  TEXT;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS variant_type   VARCHAR(50);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS variant_value  VARCHAR(100);

-- Index so we can quickly fetch all variants of the same group
CREATE INDEX IF NOT EXISTS idx_menu_items_group ON menu_items(item_group_id)
  WHERE item_group_id IS NOT NULL;
