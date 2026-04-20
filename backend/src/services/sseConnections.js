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

function addConnection(restaurantId, res) {
  if (!restaurantId || !res) return () => {};
  const key = String(restaurantId);
  let set = connections.get(key);
  if (!set) {
    set = new Set();
    connections.set(key, set);
  }
  set.add(res);

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
  let delivered = 0;
  for (const res of Array.from(set)) {
    const ok = _sendEvent(res, 'order', order);
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
  connectionCount,
  HEARTBEAT_MS,
};
