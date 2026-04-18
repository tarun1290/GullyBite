'use strict';

// Single ioredis connection, shared by BullMQ Queue + Worker. Lazy-connect
// so Vercel cold starts don't fail on boot when REDIS_URL is unreachable
// (ElastiCache is VPC-private — only EC2 workers should actually connect).
//
// BullMQ requires `maxRetriesPerRequest: null` — without it, long-running
// blocking commands (BRPOPLPUSH, etc.) fail silently under load.

const IORedis = require('ioredis');
const log = require('../utils/logger').child({ component: 'redis' });

if (!process.env.REDIS_URL) {
  log.warn('REDIS_URL not set — queue operations will fail until configured');
}

const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

connection.on('connect', () => log.info('Redis connected'));
connection.on('error', (err) => log.error({ err: err.message }, 'Redis error'));
connection.on('close', () => log.info('Redis connection closed'));

module.exports = connection;
