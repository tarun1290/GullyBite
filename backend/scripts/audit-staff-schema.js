#!/usr/bin/env node
'use strict';

// scripts/audit-staff-schema.js
//
// Read-only diagnostic. Counts and samples the `restaurant_users`
// collection so the dashboard-staff-merger can decide where each
// existing row belongs.
//
// Output (JSON, line-delimited for easy log parsing):
//   { event: 'role_count',       role: 'owner',   count: N }
//   { event: 'role_count',       role: 'manager', count: N }
//   ... one per distinct role value found in the collection
//   { event: 'has_role_preset',  count: N }     // docs with role_preset
//   { event: 'has_staff_id',     count: N }     // docs with staff_id
//   { event: 'has_permissions',  count: N }     // docs with permissions
//   { event: 'sample',           role: 'owner',   doc: { ... pin redacted ... } }
//   ... one sample per distinct role
//   { event: 'done' }
//
// HOW TO RUN (on EC2):
//
//   cd /home/ubuntu/GullyBite/backend && \
//     node --env-file=/home/ubuntu/GullyBite/.env scripts/audit-staff-schema.js
//
// READ-ONLY — performs zero writes. Safe to run against production at
// any time. The PIN-redacted sampling uses { projection: { pin_hash: 0 } }
// so the bcrypt hash never leaves the database, and any other
// hash-bearing field is also redacted defensively before printing.

const path = require('path');
const {
  connect,
  close,
  col,
} = require(path.join(__dirname, '..', 'src', 'config', 'database'));

function emit(event) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(event));
}

function redactSecrets(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const clone = { ...doc };
  // Defence-in-depth: even though projection should already strip
  // pin_hash, redact any field that smells like credential material.
  for (const key of Object.keys(clone)) {
    if (/pin_hash|password|secret|token/i.test(key)) {
      clone[key] = '[redacted]';
    }
  }
  return clone;
}

async function main() {
  await connect();
  const c = col('restaurant_users');

  // ─── Per-role counts ───────────────────────────────────────
  // Aggregation is one round-trip; matches every distinct role
  // string in the collection (incl. unexpected values).
  const roleAgg = await c.aggregate([
    { $group: { _id: '$role', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();
  for (const r of roleAgg) {
    emit({ event: 'role_count', role: r._id == null ? '(missing)' : String(r._id), count: r.count });
  }

  // ─── Field presence counts ────────────────────────────────
  const totalDocs = await c.estimatedDocumentCount();
  emit({ event: 'total_docs', count: totalDocs });

  const presetCount = await c.countDocuments({ role_preset: { $exists: true } });
  emit({ event: 'has_role_preset', count: presetCount });

  const staffIdCount = await c.countDocuments({ staff_id: { $exists: true } });
  emit({ event: 'has_staff_id', count: staffIdCount });

  const permissionsCount = await c.countDocuments({ permissions: { $exists: true } });
  emit({ event: 'has_permissions', count: permissionsCount });

  // ─── Sample per distinct role ─────────────────────────────
  // One doc per role for shape inspection. Excludes pin_hash
  // explicitly via projection, and the redactSecrets() pass below
  // catches any other secret-flavored field.
  for (const r of roleAgg) {
    const role = r._id;
    const doc = await c.findOne(
      { role },
      { projection: { pin_hash: 0 } },
    );
    if (doc) {
      emit({ event: 'sample', role: role == null ? '(missing)' : String(role), doc: redactSecrets(doc) });
    }
  }

  emit({ event: 'done' });
}

main()
  .then(async () => {
    await close().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('audit-staff-schema failed:', err && err.stack ? err.stack : err);
    await close().catch(() => {});
    process.exit(1);
  });
