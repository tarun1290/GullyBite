// src/jobs/webhook-retry.js
// Cron job: retries failed webhooks with exponential backoff
// Moves exhausted retries to a dead letter queue (DLQ)

const cron = require('node-cron');
const { col } = require('../config/database');
const { getNextRetryAt, MAX_RETRIES } = require('../utils/retry');
const log = require('../utils/logger').child({ component: 'webhook-retry' });

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

  log.info({ count: pending.length }, 'processing pending webhooks');
  const { processWA, processRP } = getProcessors();

  for (const webhookLog of pending) {
    // Atomic lock: mark as retrying to prevent concurrent processing
    const lockResult = await col('webhook_logs').updateOne(
      { _id: webhookLog._id, retry_status: 'pending' },
      { $set: { retry_status: 'retrying' } }
    );
    // If someone else already grabbed it, skip
    if (lockResult.modifiedCount === 0) continue;

    try {
      // Route to correct processor based on source
      if (webhookLog.source === 'whatsapp' && processWA) {
        await processWA(webhookLog._id, webhookLog.payload);
      } else if (webhookLog.source === 'razorpay' && processRP) {
        await processRP(webhookLog._id, webhookLog.payload);
      } else {
        throw new Error(`Unknown webhook source: ${webhookLog.source}`);
      }

      // Success
      await col('webhook_logs').updateOne(
        { _id: webhookLog._id },
        { $set: { processed: true, retry_status: 'success', processed_at: new Date(), error_message: null } }
      );
      log.info({ source: webhookLog.source, eventType: webhookLog.event_type, webhookId: webhookLog._id, retryNum: (webhookLog.retry_count || 0) + 1 }, 'webhook retry succeeded');

    } catch (err) {
      const newCount = (webhookLog.retry_count || 0) + 1;
      const errorEntry = { error: err.message, attempted_at: new Date() };

      if (newCount >= MAX_RETRIES) {
        // Move to DLQ — exhausted all retries
        await col('webhook_logs').updateOne(
          { _id: webhookLog._id },
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
        log.error({ err, source: webhookLog.source, eventType: webhookLog.event_type, webhookId: webhookLog._id, retryNum: newCount }, 'webhook moved to DLQ after max retries');
      } else {
        // Schedule next retry with exponential backoff
        await col('webhook_logs').updateOne(
          { _id: webhookLog._id },
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
        log.warn({ source: webhookLog.source, eventType: webhookLog.event_type, webhookId: webhookLog._id, retryNum: newCount, maxRetries: MAX_RETRIES, errMsg: err.message }, 'webhook retry scheduled');
      }
    }
  }
}

// ─── SCHEDULE ────────────────────────────────────────────────────
function scheduleWebhookRetry() {
  // Run every minute
  cron.schedule('* * * * *', () => {
    processRetryQueue().catch(err =>
      log.error({ err }, 'queue processing error')
    );
  }, { timezone: 'Asia/Kolkata' });
  log.info('webhook retry cron scheduled: every 60 seconds');
}

module.exports = { scheduleWebhookRetry, processRetryQueue };
