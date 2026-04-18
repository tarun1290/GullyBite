'use strict';

// Event subscription table. Require this file once at server boot — in
// backend/server.js and backend/ec2-server.js. The `global.__eventsBooted`
// guard makes re-requires safe across hot-reloads and serverless invocations.
//
// Adding a new event: (a) add it to EVENTS below, (b) add a handler to the
// relevant listener module. Adding a new listener: register it in the
// subscribe() block below.
//
// BullMQ migration path: when moving from in-process EventEmitter to a
// durable queue, bus.emit() stays the same; only the implementation of
// bus.js swaps to `queue.add(event, payload)`. Listener modules become
// BullMQ workers that pull from the queue — the function bodies don't change.

const bus = require('./bus');
const whatsappListener = require('./listeners/whatsappListener');
const notificationListener = require('./listeners/notificationListener');
const analyticsListener = require('./listeners/analyticsListener');

const EVENTS = ['order.created', 'order.updated', 'payment.completed', 'user.created'];

if (!global.__eventsBooted) {
  // Customer-facing WhatsApp — only order.created (confirmation).
  bus.on('order.created', whatsappListener.onOrderCreated);

  // Restaurant-manager notifications — order.created + order.updated.
  bus.on('order.created', notificationListener.onOrderCreated);
  bus.on('order.updated', notificationListener.onOrderUpdated);

  // Analytics/persistence — every event in EVENTS gets archived.
  for (const ev of EVENTS) {
    bus.on(ev, analyticsListener.handleEvent(ev));
  }

  global.__eventsBooted = true;
}

module.exports = bus;
