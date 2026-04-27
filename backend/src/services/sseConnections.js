'use strict';

// SSE connection manager — one Map<restaurantId, Set<res>> per process.
// Callers stream new orders + status changes to staff tablets.
//
// Single-process only. When we move to multi-process (horizontal scale
// or Vercel serverless fanout), swap the push path to Redis pub/sub and
// subscribe per-process — the public API (addConnection, removeConnection,
// pushOrderToRestaurant) stays the same.

const log = require('../utils/logger').child({ component: 'sse' });

const HEARTBEAT_MS = 25 * 1000; // defeat proxy idle timeouts (Nginx default 60s)

const connections = new Map(); // restaurantId -> Set<res>

function _safeWrite(res, payload) {
  try {
    res.write(payload);
    return true;
  } catch (err) {
    log.warn({ err: err.message }, 'SSE write failed — dropping connection');
    return false;
  }
}

// Stash branchIds on the res object so per-event filtering can read it
// without a separate parallel Map (the connections Set keys by res).
// Empty array / nullish → no branch restriction (deliver everything).
const BRANCH_IDS_KEY = '__sseBranchIds';

function addConnection(restaurantId, res, branchIds) {
  if (!restaurantId || !res) return () => {};
  const key = String(restaurantId);
  let set = connections.get(key);
  if (!set) {
    set = new Set();
    connections.set(key, set);
  }
  set.add(res);
  // Coerce to plain string array. Empty = no restriction = unscoped
  // (used by owners and unscoped staff). Stashed on `res` so the push
  // path can filter without a parallel Map.
  res[BRANCH_IDS_KEY] = Array.isArray(branchIds) ? branchIds.map(String) : [];

  const heartbeat = setInterval(() => {
    if (!_safeWrite(res, ':\n\n')) {
      clearInterval(heartbeat);
      removeConnection(key, res);
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    removeConnection(key, res);
  };
  // Express res + raw Node response both emit 'close' when the client
  // disconnects; listen on both channels so we don't leak.
  res.on('close', cleanup);
  res.on('error', cleanup);
  if (typeof res.req?.on === 'function') {
    res.req.on('close', cleanup);
    res.req.on('aborted', cleanup);
  }
  return cleanup;
}

function removeConnection(restaurantId, res) {
  const key = String(restaurantId);
  const set = connections.get(key);
  if (!set) return;
  set.delete(res);
  if (!set.size) connections.delete(key);
}

function _sendEvent(res, event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return _safeWrite(res, frame);
}

function pushOrderToRestaurant(restaurantId, order) {
  if (!restaurantId || !order) return 0;
  const key = String(restaurantId);
  const set = connections.get(key);
  if (!set || !set.size) return 0;
  // Same branch-filter rule as pushToRestaurant — connections with
  // empty branchIds get every order; connections scoped to specific
  // branches only receive orders for those branches.
  const branchId = order.branch_id != null ? String(order.branch_id) : null;
  let delivered = 0;
  for (const res of Array.from(set)) {
    const branchIds = res[BRANCH_IDS_KEY] || [];
    if (branchIds.length && branchId && !branchIds.includes(branchId)) continue;
    const ok = _sendEvent(res, 'order', order);
    if (!ok) removeConnection(key, res);
    else delivered += 1;
  }
  return delivered;
}

// Generic per-restaurant push with caller-controlled event name +
// payload. Branch-filtered the same way as pushOrderToRestaurant —
// connections with no branch restriction receive everything; scoped
// connections receive only events whose payload.branch_id matches.
// Used by /api/staff/orders/:id/status, accept/decline, and any future
// event channel that isn't strictly an order push.
function pushToRestaurant(restaurantId, eventName, data) {
  if (!restaurantId || !eventName) return 0;
  const key = String(restaurantId);
  const set = connections.get(key);
  if (!set || !set.size) return 0;
  const branchId = data && data.branch_id != null ? String(data.branch_id) : null;
  let delivered = 0;
  for (const res of Array.from(set)) {
    const branchIds = res[BRANCH_IDS_KEY] || [];
    if (branchIds.length && branchId && !branchIds.includes(branchId)) continue;
    const ok = _sendEvent(res, eventName, data || {});
    if (!ok) removeConnection(key, res);
    else delivered += 1;
  }
  return delivered;
}

function connectionCount(restaurantId) {
  if (!restaurantId) return 0;
  return connections.get(String(restaurantId))?.size || 0;
}

module.exports = {
  addConnection,
  removeConnection,
  pushOrderToRestaurant,
  pushToRestaurant,
  connectionCount,
  HEARTBEAT_MS,
};
