// src/services/catalogSyncQueue.js
// Debounced catalog sync queue — batches changes per restaurant, syncs after 3s quiet period

const { col } = require('../config/database');

const pendingSyncs = new Map(); // restaurantId → { type, branchIds, timer }
const activeSyncs = new Set();  // restaurantId set — prevents concurrent syncs

const DEBOUNCE_MS = 3000;
const RETRY_DELAY_MS = 30000;

/**
 * Queue a catalog sync for a restaurant. Non-blocking — returns immediately.
 * @param {string} restaurantId
 * @param {'full'|'branch'} type — 'full' resyncs all branches, 'branch' resyncs specific branches
 * @param {string[]} branchIds — specific branches to sync (ignored for 'full')
 */
function queueSync(restaurantId, type, branchIds) {
  if (!restaurantId) return;

  // Check restaurant has a catalog — silently skip if not
  col('restaurants').findOne({ _id: restaurantId }, { projection: { meta_catalog_id: 1 } })
    .then(r => {
      if (!r?.meta_catalog_id) return; // no catalog connected, skip

      const existing = pendingSyncs.get(restaurantId);

      if (type === 'full') {
        // Full sync supersedes any pending branch syncs
        if (existing?.timer) clearTimeout(existing.timer);
        const timer = setTimeout(() => executeSync(restaurantId), DEBOUNCE_MS);
        pendingSyncs.set(restaurantId, { type: 'full', branchIds: null, timer });
      } else {
        // Merge branch IDs
        if (existing?.type === 'full') return; // full sync pending, don't downgrade
        if (existing?.timer) clearTimeout(existing.timer);
        const merged = new Set([...(existing?.branchIds || []), ...(branchIds || [])]);
        const timer = setTimeout(() => executeSync(restaurantId), DEBOUNCE_MS);
        pendingSyncs.set(restaurantId, { type: 'branch', branchIds: [...merged], timer });
      }
    })
    .catch(() => {}); // DB check failed, skip silently
}

async function executeSync(restaurantId) {
  const pending = pendingSyncs.get(restaurantId);
  pendingSyncs.delete(restaurantId);
  if (!pending) return;

  // Simple lock — if already syncing, re-queue
  if (activeSyncs.has(restaurantId)) {
    setTimeout(() => {
      pendingSyncs.set(restaurantId, pending);
      setTimeout(() => executeSync(restaurantId), DEBOUNCE_MS);
    }, 1000);
    return;
  }

  activeSyncs.add(restaurantId);

  try {
    const catalog = require('./catalog');

    // Use compressed catalog sync — routes through compression engine first,
    // then through the existing mapMenuItemToMetaProduct pipeline.
    // Falls back to raw branch-by-branch sync if compression fails.
    try {
      const result = await catalog.syncCompressedCatalog(restaurantId);
      console.log(`[SyncQueue] Compressed sync complete for restaurant ${restaurantId}: ${result.synced || 0} SKUs synced (ratio: ${result.compressionRatio || 0}%)`);
    } catch (compErr) {
      console.error(`[SyncQueue] Compressed sync failed, falling back to raw branch sync:`, compErr.message);

      // FALLBACK: original branch-by-branch sync (preserves existing behavior)
      if (pending.type === 'full') {
        const branches = await col('branches').find({ restaurant_id: restaurantId }).toArray();
        for (const branch of branches) {
          try { await catalog.syncBranchCatalog(String(branch._id)); }
          catch (e) { console.error(`[SyncQueue] Branch ${branch.name} sync failed:`, e.message); }
        }
        console.log(`[SyncQueue] Fallback full sync complete for restaurant ${restaurantId}`);
      } else if (pending.branchIds?.length) {
        for (const branchId of pending.branchIds) {
          try { await catalog.syncBranchCatalog(branchId); }
          catch (e) { console.error(`[SyncQueue] Branch ${branchId} sync failed:`, e.message); }
        }
        console.log(`[SyncQueue] Fallback branch sync complete for restaurant ${restaurantId}`);
      }
    }
  } catch (err) {
    console.error(`[SyncQueue] Sync failed for restaurant ${restaurantId}:`, err.message);
    // Retry once after delay
    setTimeout(() => {
      const catalog = require('./catalog');
      catalog.syncCompressedCatalog(restaurantId).catch(() => {
        // If compressed fails on retry too, try raw
        col('branches').find({ restaurant_id: restaurantId }).toArray()
          .then(branches => Promise.all(branches.map(b => catalog.syncBranchCatalog(String(b._id)).catch(() => {}))))
          .catch(() => {});
      });
    }, RETRY_DELAY_MS);
  } finally {
    activeSyncs.delete(restaurantId);
  }
}

function retryFailedSyncs() {
  // Called on server startup — no-op for now since we don't persist sync state
  // The debounce model means pending syncs are lost on restart
  // A full sync is triggered when the restaurant next visits the dashboard anyway
  console.log('[SyncQueue] Ready');
}

module.exports = { queueSync, retryFailedSyncs };
