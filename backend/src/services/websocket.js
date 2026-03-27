// src/services/websocket.js
// Fire-and-forget WebSocket broadcast via AWS Lambda.
// If BROADCAST_LAMBDA_URL is not configured, all calls skip silently.

'use strict';

const BROADCAST_URL = process.env.BROADCAST_LAMBDA_URL || '';
const BROADCAST_KEY = process.env.BROADCAST_API_KEY || '';

async function _send(body) {
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
    if (err.name !== 'AbortError') {
      console.warn('[WS] Broadcast failed:', err.message);
    }
  }
}

function broadcast(room, event, data) {
  _send({ room, event, data }).catch(() => {});
}

function broadcastMulti(rooms, event, data) {
  _send({ rooms, event, data }).catch(() => {});
}

function broadcastToRestaurant(restaurantId, event, data) {
  broadcast('restaurant:' + restaurantId, event, data);
}

function broadcastToAdmin(event, data) {
  broadcast('admin:global', event, data);
}

function broadcastOrder(restaurantId, event, data) {
  broadcastMulti(['restaurant:' + restaurantId, 'admin:global'], event, data);
}

module.exports = { broadcast, broadcastMulti, broadcastToRestaurant, broadcastToAdmin, broadcastOrder };
