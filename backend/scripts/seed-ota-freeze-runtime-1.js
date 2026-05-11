'use strict';

// scripts/seed-ota-freeze-runtime-1.js
//
// One-shot seed: upsert the OTA runtime-freeze doc that pins runtime "1"
// closed. Manifest requests for runtime "1" will then short-circuit to
// `{type:'noUpdateAvailable'}` instead of serving the contaminated bundle
// (id ab09ba56-42aa-4f05-bb83-5013bb7f7a90, published 2026-05-09) that
// the in-circulation APK cannot load (built before native modules
// expo-updates / expo-build-properties landed; bundle compiled against
// them crashes at the native bridge below the JS try/catch).
//
// WHY
// ---
// `runtimeVersion: { policy: 'nativeVersion' }` in staff-app/app.config.js
// pins the bundle namespace to android.versionCode. versionCode was bumped
// 1 → 2 in a prior commit, but the runtime-"1" namespace stays populated
// in `ota_updates` and would re-serve the bad bundle to any APK that still
// thinks it's on runtime "1" (devices that haven't yet picked up the new
// APK). The freeze flag is the operational fail-safe during the rollout
// window — it costs nothing to leave in place even after every device is
// on versionCode 2.
//
// IDEMPOTENCY
// -----------
// Upsert with $addToSet so re-running this script is a no-op once "1" is
// already in the runtimes array. To unfreeze later, hit the admin
// endpoint `POST /api/admin/ota/unfreeze-runtime { "runtime": "1" }`.
//
// HOW TO RUN (on EC2)
// -------------------
//   cd /home/ubuntu/GullyBite/backend && \
//     node --env-file=/home/ubuntu/GullyBite/.env scripts/seed-ota-freeze-runtime-1.js
//
// EXIT CODES
// ----------
// 0 on success (including no-op re-run).
// 1 on any connect / op error.

const path = require('path');
const { connect, close, col } = require(path.join(__dirname, '..', 'src', 'config', 'database'));

async function main() {
  await connect();

  const now = new Date();
  await col('platform_settings').updateOne(
    { _id: 'ota_frozen_runtimes' },
    {
      $addToSet: { runtimes: '1' },
      $set: { updated_at: now },
      $setOnInsert: { created_at: now },
    },
    { upsert: true },
  );

  // Read back the final state so the operator sees what landed.
  const doc = await col('platform_settings').findOne({ _id: 'ota_frozen_runtimes' });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: 'ota_freeze_seeded', doc }, null, 2));
}

main()
  .then(async () => {
    await close().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('seed-ota-freeze-runtime-1 failed:', err && err.stack ? err.stack : err);
    await close().catch(() => {});
    process.exit(1);
  });
