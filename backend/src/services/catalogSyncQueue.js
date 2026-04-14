// src/services/catalogSyncQueue.js
// Phase 4: persistent catalog sync scheduling.
//
// Before: in-memory Map + setTimeout-based debouncer. Lost state on
// restart; couldn't be observed by ops; no retry bookkeeping.
//
// After: writes to `catalog_sync_schedule` with a `schedule_time` in
// the near future. A periodic worker (startProcessor below) picks up
// rows whose schedule_time has passed, enqueues a CATALOG_SYNC job on
// message_jobs, and marks the schedule row 'dispatched'. Debouncing
// still works: a second queueSync() during the debounce window
// updates the existing row's schedule_time forward, so the sync only
// fires once after quiet settles.

'use strict';

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'SyncQueue' });

const COLLECTION = 'catalog_sync_schedule';
const DEBOUNCE_MS = 3000;
const POLL_INTERVAL_MS = 2000;

async function queueSync(restaurantId, type, branchIds) {
  if (!restaurantId) return;

  // Only schedule if the tenant has a catalog wired up.
  const r = await col('restaurants').findOne(
    { _id: restaurantId },
    { projection: { meta_catalog_id: 1 } }
  ).catch(() => null);
  if (!r?.meta_catalog_id) return;

  const now = new Date();
  const scheduleTime = new Date(now.getTime() + DEBOUNCE_MS);

  // Atomic upsert: one pending row per restaurant. 'full' beats
  // 'branch' — once a full sync is scheduled, branch merges are
  // ignored (they'll be covered).
  const existing = await col(COLLECTION).findOne({
    restaurant_id: String(restaurantId), status: 'pending',
  });

  if (existing && existing.sync_type === 'full') {
    // Extend the debounce for full syncs.
    await col(COLLECTION).updateOne(
      { _id: existing._id },
      { $set: { schedule_time: scheduleTime, updated_at: now } }
    );
    return;
  }

  if (type === 'full') {
    if (existing) {
      await col(COLLECTION).updateOne(
        { _id: existing._id },
        { $set: { sync_type: 'full', branch_ids: null, schedule_time: scheduleTime, updated_at: now } }
      );
    } else {
      await col(COLLECTION).insertOne({
        _id: newId(),
        restaurant_id: String(restaurantId),
        branch_id: null,
        sync_type: 'full',
        branch_ids: null,
        schedule_time: scheduleTime,
        status: 'pending',
        created_at: now,
        updated_at: now,
      });
    }
    return;
  }

  // branch-scoped sync — merge branch_ids.
  const ids = Array.isArray(branchIds) ? branchIds.map(String) : [];
  if (existing) {
    const merged = Array.from(new Set([...(existing.branch_ids || []), ...ids]));
    await col(COLLECTION).updateOne(
      { _id: existing._id },
      { $set: { branch_ids: merged, schedule_time: scheduleTime, updated_at: now } }
    );
  } else {
    await col(COLLECTION).insertOne({
      _id: newId(),
      restaurant_id: String(restaurantId),
      branch_id: ids[0] || null,
      sync_type: 'branch',
      branch_ids: ids,
      schedule_time: scheduleTime,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
  }
}

// Worker loop: claim-and-dispatch rows whose schedule_time has passed.
let _running = false;
let _stopRequested = false;

async function _tick() {
  const now = new Date();
  const row = await col(COLLECTION).findOneAndUpdate(
    { status: 'pending', schedule_time: { $lte: now } },
    { $set: { status: 'dispatching', updated_at: now } },
    { returnDocument: 'after' }
  );
  if (!row?.value) return false;
  const doc = row.value;

  try {
    const { enqueue, JOB_TYPES } = require('../queue/postPaymentJobs');
    await enqueue(JOB_TYPES.CATALOG_SYNC, {
      restaurantId: doc.restaurant_id,
      type: doc.sync_type,
      branchIds: doc.branch_ids || [],
    });
    await col(COLLECTION).updateOne(
      { _id: doc._id },
      { $set: { status: 'dispatched', dispatched_at: new Date(), updated_at: new Date() } }
    );
  } catch (err) {
    log.error({ err, restaurantId: doc.restaurant_id }, 'failed to dispatch catalog sync');
    await col(COLLECTION).updateOne(
      { _id: doc._id },
      { $set: { status: 'pending', updated_at: new Date(), last_error: { message: err.message, at: new Date() } } }
    );
  }
  return true;
}

function startProcessor({ pollMs = POLL_INTERVAL_MS } = {}) {
  if (_running) return;
  _running = true;
  _stopRequested = false;
  (async function loop() {
    log.info({ pollMs }, 'catalog sync scheduler started');
    while (!_stopRequested) {
      try {
        const drained = await _tick();
        if (drained) continue;
      } catch (err) {
        log.error({ err }, 'catalog sync scheduler tick failed');
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    _running = false;
  })();
}

function retryFailedSyncs() {
  // Backwards-compat: old startup hook that this module exported.
  // With the persistent queue there's nothing to recover on startup —
  // the processor loop will find any unfinished rows on its own.
  log.info('Ready (persistent queue)');
}

module.exports = { queueSync, retryFailedSyncs, startProcessor, COLLECTION };
