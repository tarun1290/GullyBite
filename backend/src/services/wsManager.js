// src/services/wsManager.js
// WebSocket connection manager for EC2 backend.
// Tracks connected dashboard clients per restaurant, handles broadcast.
// On Vercel (no WS server), this module exports no-ops.

'use strict';

const log = require('../utils/logger').child({ component: 'WS' });

const connections = new Map(); // restaurantId → Set<ws>
const adminConnections = new Set();
let _wss = null; // Set by ec2-server.js after WebSocket server is created

function init(wss) {
  _wss = wss;
  log.info('Manager initialized');
}

function addConnection(restaurantId, ws) {
  if (restaurantId === 'admin') {
    adminConnections.add(ws);
  } else {
    if (!connections.has(restaurantId)) connections.set(restaurantId, new Set());
    connections.get(restaurantId).add(ws);
  }
}

function removeConnection(restaurantId, ws) {
  if (restaurantId === 'admin') {
    adminConnections.delete(ws);
  } else {
    const set = connections.get(restaurantId);
    if (set) { set.delete(ws); if (set.size === 0) connections.delete(restaurantId); }
  }
}

function getConnectionCount() {
  let total = adminConnections.size;
  for (const set of connections.values()) total += set.size;
  return total;
}

function _send(ws, data) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(data)); // 1 = OPEN
  } catch (e) { log.warn({ err: e }, 'Send failed'); }
}

function broadcastToRestaurant(restaurantId, event) {
  const set = connections.get(restaurantId);
  if (!set?.size) return;
  const msg = { ...event, timestamp: new Date().toISOString() };
  for (const ws of set) _send(ws, msg);
}

function broadcastToAdmin(event) {
  if (!adminConnections.size) return;
  const msg = { ...event, timestamp: new Date().toISOString() };
  for (const ws of adminConnections) _send(ws, msg);
}

function broadcastToAll(event) {
  const msg = { ...event, timestamp: new Date().toISOString() };
  for (const set of connections.values()) for (const ws of set) _send(ws, msg);
  for (const ws of adminConnections) _send(ws, msg);
}

function isActive() { return !!_wss; }

module.exports = { init, addConnection, removeConnection, getConnectionCount, broadcastToRestaurant, broadcastToAdmin, broadcastToAll, isActive };
