// src/services/delivery/mock.js
// Mock 3PL delivery provider for testing — simulates quotes, dispatch, and status updates.
// No external API calls. Uses in-memory task storage.
// Set DEFAULT_DELIVERY_PROVIDER=mock to activate.

'use strict';

const { v4: uuidv4 } = require('uuid');
const log = require('../../../utils/logger').child({ component: 'MockDelivery' });

// In-memory task store (resets on server restart)
const _tasks = new Map();

// ─── HAVERSINE DISTANCE ─────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── GET QUOTE ──────────────────────────────────────────────
async function getQuote(pickup, drop, orderDetails = {}) {
  const distanceKm = haversineKm(pickup.lat, pickup.lng, drop.lat, drop.lng);
  const baseFee = 25;
  const perKmRate = 8;
  const surgeActive = Math.random() < 0.2;
  const surgeMultiplier = surgeActive ? 1.5 : 1;
  const deliveryFeeRs = parseFloat(((baseFee + perKmRate * distanceKm) * surgeMultiplier).toFixed(2));
  const estimatedMins = Math.round(distanceKm * 5 + 10);

  return {
    deliveryFeeRs,
    estimatedMins,
    distanceKm: parseFloat(distanceKm.toFixed(1)),
    quoteId: `mock_quote_${uuidv4().slice(0, 8)}`,
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
    surgeActive,
    providerName: 'mock',
  };
}

// ─── CREATE TASK (DISPATCH) ─────────────────────────────────
async function createTask(pickup, drop, orderDetails = {}, quoteId = null) {
  const taskId = `mock_task_${uuidv4().slice(0, 8)}`;
  const trackingUrl = `https://track.gullybite.com/mock/${taskId}`;

  const task = {
    taskId,
    trackingUrl,
    estimatedMins: Math.round(haversineKm(pickup.lat, pickup.lng, drop.lat, drop.lng) * 5 + 10),
    status: 'assigned',
    driverName: 'Mock Rider',
    driverPhone: '+919999900000',
    driverLat: drop.lat + (Math.random() - 0.5) * 0.01,
    driverLng: drop.lng + (Math.random() - 0.5) * 0.01,
    pickup, drop, orderDetails,
    createdAt: new Date(),
  };

  _tasks.set(taskId, task);

  // Simulate status progression (for testing)
  setTimeout(() => { if (_tasks.get(taskId)?.status === 'assigned') { _tasks.get(taskId).status = 'picked_up'; log.info({ taskId }, 'Task picked_up'); } }, 30000);
  setTimeout(() => { if (_tasks.get(taskId)?.status === 'picked_up') { _tasks.get(taskId).status = 'in_transit'; log.info({ taskId }, 'Task in_transit'); } }, 90000);
  setTimeout(() => { if (_tasks.get(taskId)?.status === 'in_transit') { _tasks.get(taskId).status = 'delivered'; _tasks.get(taskId).deliveredAt = new Date(); log.info({ taskId }, 'Task delivered'); } }, 180000);

  log.info({ taskId, trackingUrl }, 'Task created');
  return task;
}

// ─── CANCEL TASK ────────────────────────────────────────────
async function cancelTask(taskId) {
  const task = _tasks.get(taskId);
  if (task) {
    task.status = 'cancelled';
    log.info({ taskId }, 'Task cancelled');
    return { success: true, refundable: true };
  }
  return { success: false, refundable: false };
}

// ─── GET TASK STATUS ────────────────────────────────────────
async function getTaskStatus(taskId) {
  const task = _tasks.get(taskId);
  if (!task) return { status: 'not_found' };

  return {
    status: task.status,
    driverName: task.driverName,
    driverPhone: task.driverPhone,
    driverLat: task.driverLat,
    driverLng: task.driverLng,
    estimatedMins: task.estimatedMins,
    trackingUrl: task.trackingUrl,
  };
}

// ─── NORMALIZE STATUS ───────────────────────────────────────
function normalizeStatus(raw) {
  const map = {
    assigned: 'assigned', picked_up: 'picked_up', in_transit: 'in_transit',
    delivered: 'delivered', cancelled: 'cancelled', failed: 'failed', pending: 'pending',
  };
  return map[raw] || 'pending';
}

module.exports = { getQuote, createTask, cancelTask, getTaskStatus, normalizeStatus };
