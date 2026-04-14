// src/queue/messageWorker.js
// Worker wiring for the message queue. Pulls jobs from `message_jobs`
// and invokes services/whatsapp.sendMessage with the stored payload.
// Kept separate from messageQueue.js so the queue primitives have no
// dependency on the WhatsApp service (easier to test / swap handlers).
//
// Usage — call once from server.js during startup:
//
//   require('./queue/messageWorker').start();

'use strict';

const { startWorker, stopWorker, JOB_NAME } = require('./messageQueue');
const wa = require('../services/whatsapp');
const log = require('../utils/logger').child({ component: 'messageWorker' });

async function handler(payload = {}) {
  // Delegates to the brand-aware sendMessage so all routing, strict
  // multi-brand checks, and fallback_reason logging apply inside the
  // job's retry budget rather than on the request path.
  return wa.sendMessage(payload);
}

function start() {
  startWorker({ handler, name: JOB_NAME });
  log.info('message worker wired to wa.sendMessage');
}

module.exports = { start, stop: stopWorker, handler };
