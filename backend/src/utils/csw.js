'use strict';

const CSW_WINDOW_MS = 24 * 60 * 60 * 1000;

async function isWithinCSW(customerId, db) {
  if (!customerId || !db) return false;
  const doc = await db.collection('customer_messages').findOne(
    { customer_id: customerId, direction: 'inbound' },
    { projection: { created_at: 1 }, sort: { created_at: -1 } },
  );
  if (!doc || !doc.created_at) return false;
  const last = new Date(doc.created_at).getTime();
  if (!Number.isFinite(last)) return false;
  return (Date.now() - last) < CSW_WINDOW_MS;
}

function csw24hCutoff() {
  return new Date(Date.now() - CSW_WINDOW_MS);
}

module.exports = { isWithinCSW, csw24hCutoff };
