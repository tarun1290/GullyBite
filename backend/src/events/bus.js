'use strict';

// Central event bus. Listeners are isolated — a throw or rejection in one
// does not prevent the others from running, nor does it crash the process.
// Use `on(event, handler)` to subscribe and `emit(event, payload)` to publish.
// Emit is fire-and-forget: it returns synchronously; async listeners run in
// the background with their errors captured to the log.

const { EventEmitter } = require('events');
const log = require('../utils/logger').child({ component: 'event-bus' });

const _bus = new EventEmitter();
_bus.setMaxListeners(50);

function emit(event, payload) {
  const listeners = _bus.listeners(event);
  if (listeners.length === 0) {
    log.warn({ event }, 'No listeners registered for event');
    return;
  }
  log.info({ event, count: listeners.length }, 'Dispatching event');
  for (const fn of listeners) {
    const name = fn.name || 'anonymous';
    Promise.resolve()
      .then(() => fn(payload))
      .catch((err) => log.error({ event, listener: name, err: err.message }, 'Listener failed'));
  }
}

function on(event, handler) {
  _bus.on(event, handler);
}

function off(event, handler) {
  _bus.off(event, handler);
}

function listenerCount(event) {
  return _bus.listenerCount(event);
}

module.exports = { emit, on, off, listenerCount };
