// src/services/websocket.js
// Fire-and-forget WebSocket broadcast.
// On EC2: broadcasts directly via wsManager (local WebSocket server).
// On Vercel: broadcasts via AWS Lambda (if configured), else skips silently.

'use strict';

const wsManager = require('./wsManager');
const log = require('../utils/logger').child({ component: 'WSBroadcast' });

const BROADCAST_URL = process.env.BROADCAST_LAMBDA_URL || '';
const BROADCAST_KEY = process.env.BROADCAST_API_KEY || '';

// Direct local broadcast (EC2 with ws server running)
function _localBroadcast(restaurantId, event, data) {
  if (!wsManager.isActive()) return false;
  try {
    const msg = { type: event, data };
    if (restaurantId === 'admin') {
      wsManager.broadcastToAdmin(msg);
    } else {
      wsManager.broadcastToRestaurant(restaurantId, msg);
    }
    return true;
  } catch { return false; }
}

// Remote broadcast via Lambda (Vercel fallback)
async function _remoteBroadcast(body) {
  if (!BROADCAST_URL) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    await fetch(BROADCAST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': BROADCAST_KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    if (err.name !== 'AbortError') log.warn({ err }, 'Remote broadcast failed');
  }
}

function broadcast(room, event, data) {
  // Try local first (EC2), then remote (Lambda)
  const restaurantId = room.replace('restaurant:', '').replace('admin:global', 'admin');
  if (_localBroadcast(restaurantId, event, data)) return;
  _remoteBroadcast({ room, event, data }).catch(() => {});
}

function broadcastMulti(rooms, event, data) {
  for (const room of rooms) broadcast(room, event, data);
}

function broadcastToRestaurant(restaurantId, event, data) {
  if (_localBroadcast(restaurantId, event, data)) return;
  _remoteBroadcast({ room: 'restaurant:' + restaurantId, event, data }).catch(() => {});
}

function broadcastToAdmin(event, data) {
  if (_localBroadcast('admin', event, data)) return;
  _remoteBroadcast({ room: 'admin:global', event, data }).catch(() => {});
}

function broadcastOrder(restaurantId, event, data) {
  broadcastToRestaurant(restaurantId, event, data);
  broadcastToAdmin(event, data);
}

module.exports = { broadcast, broadcastMulti, broadcastToRestaurant, broadcastToAdmin, broadcastOrder };
