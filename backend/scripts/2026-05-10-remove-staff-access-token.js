'use strict';

// 2026-05-10-remove-staff-access-token.js
//
// One-shot migration: drop the legacy per-branch staff_access_token (and
// its companion staff_access_token_generated_at) from every document in
// the `branches` collection.
//
// WHY
// ---
// Part 6 / 6b moved staff onto a credential login (store_slug + staff_id
// + PIN). The old URL-token flow — staff opened /staff/<uuid> on a
// tablet which scoped them to a branch — has been hard-removed:
//   - GET  /api/restaurant/branches/:branchId/staff-link            (deleted)
//   - POST /api/restaurant/branches/:branchId/staff-link/generate   (deleted)
//   - GET  /api/staff/branch-info?token=<uuid>                      (deleted)
//   - frontend /staff/<token>                                       (now redirects)
// The fields linger on every existing branch doc with no reader. This
// script unsets them so we don't carry dead data forward.
//
// HOW TO RUN
// ----------
// On EC2 (production):
//   node --env-file=/home/ubuntu/GullyBite/.env backend/scripts/2026-05-10-remove-staff-access-token.js
//
// Locally (against staging or a copy):
//   node --env-file=.env backend/scripts/2026-05-10-remove-staff-access-token.js
//
// IDEMPOTENCY
// -----------
// updateMany with $unset on absent fields is a no-op per doc; running
// the script twice is safe. The second run will print modified: 0.
//
// EXIT CODES
// ----------
// 0 on success (including when no docs needed updating).
// 1 on any connect / op error.

const { connect, close, col } = require('../src/config/database');

(async () => {
  try {
    await connect();
    const result = await col('branches').updateMany(
      {},
      { $unset: { staff_access_token: '', staff_access_token_generated_at: '' } }
    );
    // The driver returns matchedCount / modifiedCount on UpdateResult.
    // Older driver versions may surface them as `matched`/`modified` —
    // fall back so this doesn't print `undefined` if upstream changes.
    const matched = result.matchedCount ?? result.matched ?? 0;
    const modified = result.modifiedCount ?? result.modified ?? 0;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ matched, modified }));
    await close();
    process.exit(0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Migration failed:', err && err.message ? err.message : err);
    try { await close(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
})();
