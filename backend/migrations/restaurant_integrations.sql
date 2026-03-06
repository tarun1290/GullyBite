-- Migration: restaurant_integrations
-- Run once in your Supabase SQL editor

CREATE TABLE IF NOT EXISTS restaurant_integrations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  platform        VARCHAR(50) NOT NULL,   -- 'petpooja' | 'swiggy' | 'zomato'
  branch_id       UUID        REFERENCES branches(id) ON DELETE SET NULL,  -- which branch to sync into
  api_key         TEXT,
  api_secret      TEXT,
  access_token    TEXT,
  outlet_id       TEXT,                  -- platform-specific outlet / restaurant ID
  extra_config    JSONB       DEFAULT '{}',
  is_active       BOOLEAN     DEFAULT FALSE,
  last_synced_at  TIMESTAMPTZ,
  sync_status     VARCHAR(20) DEFAULT 'idle',   -- idle | syncing | success | error
  sync_error      TEXT,
  item_count      INTEGER     DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, platform)
);

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_integrations_restaurant ON restaurant_integrations(restaurant_id);

-- Add external_id to menu_items so POS items can be upserted by POS ID
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_external ON menu_items(branch_id, external_id)
  WHERE external_id IS NOT NULL;
