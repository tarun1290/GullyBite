'use strict';

const CSW_WINDOW_MS = 24 * 60 * 60 * 1000;

// Reads customers.last_inbound_at, stamped on EVERY inbound webhook
// message at webhooks/whatsapp.js's handleMessage (after customer
// resolution, before the per-type dispatch). The previous source —
// customer_messages.direction:'inbound' — was only written by
// captureCustomerMessage on the dead-letter branch (unrecognised text
// fallback and non-{text,interactive,order,location,contacts} types),
// so an active ordering customer showed as outside CSW and every
// post-payment status update was silently suppressed.
async function isWithinCSW(customerId, db) {
  if (!customerId || !db) return false;
  const doc = await db.collection('customers').findOne(
    { _id: customerId },
    { projection: { last_inbound_at: 1 } },
  );
  if (!doc || !doc.last_inbound_at) return false;
  const last = new Date(doc.last_inbound_at).getTime();
  if (!Number.isFinite(last)) return false;
  return (Date.now() - last) < CSW_WINDOW_MS;
}

function csw24hCutoff() {
  return new Date(Date.now() - CSW_WINDOW_MS);
}

module.exports = { isWithinCSW, csw24hCutoff };
