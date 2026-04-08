// src/jobs/pos-sync.js
// Cron: periodically pulls menu updates from connected POS platforms
// Backup for webhook-based real-time updates — runs every 30 minutes

const { col } = require('../config/database');
const { POS_INTEGRATIONS_ENABLED } = require('../config/features');
const { triggerSync } = require('../services/posSync');
const log = require('../utils/logger').child({ component: 'pos-sync' });

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const RECENT_THRESHOLD_MS = 25 * 60 * 1000; // skip if synced within 25 min

let _timer = null;

async function runPosSync() {
  if (!POS_INTEGRATIONS_ENABLED) return;

  try {
    const integrations = await col('restaurant_integrations').find({
      is_active: true,
      sync_status: { $ne: 'syncing' },
    }).toArray();

    let synced = 0, skipped = 0;
    const now = Date.now();

    for (const int of integrations) {
      // Skip recently synced
      if (int.last_synced_at && (now - new Date(int.last_synced_at).getTime()) < RECENT_THRESHOLD_MS) {
        skipped++;
        continue;
      }

      // Check restaurant has catalog sync enabled
      const restaurant = await col('restaurants').findOne({ _id: int.restaurant_id });
      if (restaurant && restaurant.catalog_sync_enabled === false) {
        skipped++;
        continue;
      }

      try {
        await triggerSync(int.platform, String(int._id), int.restaurant_id, 'incremental');
        synced++;
      } catch (err) {
        log.error({ err, platform: int.platform, integrationId: String(int._id) }, 'POS cron sync failed');
      }

      // Rate limit: 3-second delay between syncs
      await new Promise(r => setTimeout(r, 3000));
    }

    if (synced > 0 || skipped > 0) {
      log.info({ synced, skipped }, 'POS cron sync complete');
    }
  } catch (err) {
    log.error({ err }, 'POS cron error');
  }
}

function schedulePosSync() {
  if (!POS_INTEGRATIONS_ENABLED) {
    log.info('POS integrations disabled — cron not started');
    return;
  }
  log.info('POS sync scheduled every 30 minutes');
  _timer = setInterval(runPosSync, INTERVAL_MS);
  // Run first sync 60 seconds after server start
  setTimeout(runPosSync, 60000);
}

function stopPosSync() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { schedulePosSync, stopPosSync, runPosSync };
