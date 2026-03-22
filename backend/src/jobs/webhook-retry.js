// src/jobs/webhook-retry.js
// Cron job: retries failed webhooks with exponential backoff
// Moves exhausted retries to a dead letter queue (DLQ)

const cron = require('node-cron');
const { col } = require('../config/database');
const { getNextRetryAt, MAX_RETRIES } = require('../utils/retry');

// Lazy-load processors to avoid circular dependency issues at startup
let _processWA = null;
let _processRP = null;

function getProcessors() {
  if (!_processWA) _processWA = require('../webhooks/whatsapp').processWhatsAppWebhook;
  if (!_processRP) _processRP = require('../webhooks/razorpay').processRazorpayWebhook;
  return { processWA: _processWA, processRP: _processRP };
}

// ─── PROCESS RETRY QUEUE ─────────────────────────────────────────
async function processRetryQueue() {
  const now = new Date();

  // Find webhooks that need retrying
  const pending = await col('webhook_logs').find({
    retry_status: 'pending',
    next_retry_at: { $lte: now },
    retry_count: { $lt: MAX_RETRIES },
    moved_to_dlq: false,
  }).sort({ next_retry_at: 1 }).limit(10).toArray();

  if (!pending.length) return;

  console.log(`[Retry] Processing ${pending.length} pending webhook(s)`);
  const { processWA, processRP } = getProcessors();

  for (const log of pending) {
    // Atomic lock: mark as retrying to prevent concurrent processing
    const lockResult = await col('webhook_logs').updateOne(
      { _id: log._id, retry_status: 'pending' },
      { $set: { retry_status: 'retrying' } }
    );
    // If someone else already grabbed it, skip
    if (lockResult.modifiedCount === 0) continue;

    try {
      // Route to correct processor based on source
      if (log.source === 'whatsapp' && processWA) {
        await processWA(log._id, log.payload);
      } else if (log.source === 'razorpay' && processRP) {
        await processRP(log._id, log.payload);
      } else {
        throw new Error(`Unknown webhook source: ${log.source}`);
      }

      // Success
      await col('webhook_logs').updateOne(
        { _id: log._id },
        { $set: { processed: true, retry_status: 'success', processed_at: new Date(), error_message: null } }
      );
      console.log(`[Retry] ✅ ${log.source}/${log.event_type} (${log._id}) succeeded on retry ${(log.retry_count || 0) + 1}`);

    } catch (err) {
      const newCount = (log.retry_count || 0) + 1;
      const errorEntry = { error: err.message, attempted_at: new Date() };

      if (newCount >= MAX_RETRIES) {
        // Move to DLQ — exhausted all retries
        await col('webhook_logs').updateOne(
          { _id: log._id },
          {
            $set: {
              retry_status: 'exhausted',
              moved_to_dlq: true,
              dlq_at: new Date(),
              last_error: err.message,
              retry_count: newCount,
            },
            $push: { error_history: errorEntry },
          }
        );
        console.error(`[Retry] ❌ ${log.source}/${log.event_type} (${log._id}) moved to DLQ after ${newCount} retries: ${err.message}`);
      } else {
        // Schedule next retry with exponential backoff
        await col('webhook_logs').updateOne(
          { _id: log._id },
          {
            $set: {
              retry_status: 'pending',
              next_retry_at: getNextRetryAt(newCount),
              last_error: err.message,
              retry_count: newCount,
            },
            $push: { error_history: errorEntry },
          }
        );
        console.warn(`[Retry] ⏳ ${log.source}/${log.event_type} (${log._id}) retry ${newCount}/${MAX_RETRIES} scheduled: ${err.message}`);
      }
    }
  }
}

// ─── SCHEDULE ────────────────────────────────────────────────────
function scheduleWebhookRetry() {
  // Run every minute
  cron.schedule('* * * * *', () => {
    processRetryQueue().catch(err =>
      console.error('[Retry] Queue processing error:', err.message)
    );
  }, { timezone: 'Asia/Kolkata' });
  console.log('⏰ Webhook retry cron scheduled: every 60 seconds');
}

module.exports = { scheduleWebhookRetry, processRetryQueue };
