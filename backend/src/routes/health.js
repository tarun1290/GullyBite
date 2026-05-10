'use strict';

// Health endpoints.
//
//   GET /api/health        — shallow liveness. Process-only, no dep calls.
//   GET /api/health/ready  — deep readiness. Pings Mongo + Redis in parallel
//                            with per-check ~2s timeouts, plus an env-var
//                            presence audit. Each check is independently
//                            try/catch'd so the endpoint itself never
//                            throws when a dependency is down.
//
// Mounted in ec2-server.js BEFORE ensureConnected so liveness keeps
// answering even when Mongo is unreachable. No auth, no rate limit —
// load balancers + uptime monitors hit these unauthenticated.

const express = require('express');
const router = express.Router();
const { connect } = require('../config/database');
const redisConnection = require('../queue/redis');

const CHECK_TIMEOUT_MS = 2000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}

async function checkMongo() {
  const t0 = Date.now();
  try {
    const db = await withTimeout(connect(), CHECK_TIMEOUT_MS, 'mongo connect');
    await withTimeout(db.command({ ping: 1 }), CHECK_TIMEOUT_MS, 'mongo ping');
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, error: err.message };
  }
}

async function checkRedis() {
  const t0 = Date.now();
  try {
    const pong = await withTimeout(redisConnection.ping(), CHECK_TIMEOUT_MS, 'redis ping');
    if (pong !== 'PONG') throw new Error(`unexpected ping response: ${pong}`);
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, error: err.message };
  }
}

const REQUIRED_ENV = [
  'MONGODB_URI',
  'REDIS_URL',
  'META_SYSTEM_USER_TOKEN',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'JWT_SECRET',
];

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  return { ok: missing.length === 0, missing };
}

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime_seconds: process.uptime(),
    ts: Date.now(),
    node_version: process.version,
    pid: process.pid,
  });
});

router.get('/health/ready', async (req, res) => {
  const [mongodb, redis] = await Promise.all([checkMongo(), checkRedis()]);
  const env = checkEnv();
  const ok = mongodb.ok && redis.ok && env.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    checks: { mongodb, redis, env },
    ts: Date.now(),
  });
});

module.exports = router;
