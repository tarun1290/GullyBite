-- ================================================================
-- Migration: WhatsApp Pay + Razorpay Payouts
-- Run with: psql $DATABASE_URL -f src/models/migrate_whatsapp_pay.sql
-- Safe to run multiple times
-- ================================================================

-- payments: distinguish WhatsApp Pay vs Payment Link
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20) DEFAULT 'whatsapp_pay';

-- Backfill: existing rows (created before this migration) used payment links
UPDATE payments SET payment_type = 'link' WHERE rp_link_id IS NOT NULL AND payment_type = 'whatsapp_pay';

DO $$ BEGIN RAISE NOTICE 'Migration complete: WhatsApp Pay payment_type column added.'; END $$;
