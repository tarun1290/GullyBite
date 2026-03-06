-- ================================================================
-- GullyBite — Email/Password Authentication
-- Run in: Supabase Dashboard → SQL Editor
-- ================================================================

-- Password hash for email+password sign in
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Ensure email has a unique index (it already has UNIQUE constraint in schema)
-- but if it doesn't, add one:
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename='restaurants' AND indexname='restaurants_email_key'
  ) THEN
    CREATE UNIQUE INDEX restaurants_email_key ON restaurants(email);
  END IF;
END $$;

DO $$ BEGIN
  RAISE NOTICE '✅ Password auth migration complete';
END $$;
