'use strict';

// Socket.io fan-out helper. Both backend entrypoints (ec2-server.js,
// server.js local-dev branch) construct their own socket.io Server and
// register it here via init(io). Order-write code paths import
// emitToRestaurant() and fire-and-forget; never await, never throw.
//
// Why a setter (instead of `module.exports.io = io` from the entry):
// the entry files end with `module.exports = app` for the Vercel
// adapter, which would clobber a direct property assignment. This
// mirrors how wsManager.init(wss) is wired in ec2-server.js.
//
// Supported events (room: `restaurant:<restaurantId>`):
//   'order:new'      — new order received from WhatsApp
//   'order:updated'  — order status changed (CONFIRMED, PREPARING,
//                      PACKED, DISPATCHED, DELIVERED, ...)
//   'order:paid'     — Razorpay payment confirmed

let _io = null;

function init(io) {
  _io = io;
}

function emitToRestaurant(restaurantId, event, data) {
  if (!_io) return;
  if (!restaurantId || !event) return;
  try {
    _io.to(`restaurant:${restaurantId}`).emit(event, data);
  } catch (_e) {
    // Socket failures must never break the order pipeline. Swallow
    // and move on; SSE / WS / push channels handle the same fan-out.
  }
}

// Fan-out to the global admin room. Used by webhook + state-engine
// emit sites that want admins to see the same events restaurants do
// (order lifecycle today; could expand to settlement / abuse signals).
// The room is joined by every authenticated admin socket — see the
// io.on('connection') handler in ec2-server.js / server.js.
function emitToAdmin(event, data) {
  if (!_io) return;
  if (!event) return;
  try {
    _io.to('admin:platform').emit(event, data);
  } catch (_e) {
    // Same fail-silent contract as emitToRestaurant.
  }
}

module.exports = { init, emitToRestaurant, emitToAdmin };
