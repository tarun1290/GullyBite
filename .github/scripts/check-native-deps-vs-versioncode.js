#!/usr/bin/env node
'use strict';

// .github/scripts/check-native-deps-vs-versioncode.js
//
// CI guard. Runs in the staff-app APK build workflow BEFORE
// `npx expo prebuild`. Fails the build (exit 1) when a commit adds
// or removes a native-module dependency in staff-app/package.json
// WITHOUT bumping android.versionCode in staff-app/app.config.js.
//
// WHY
// ---
// staff-app/app.config.js pins runtimeVersion to nativeVersion (i.e.
// android.versionCode). The OTA channel namespace is therefore keyed
// on versionCode. When a native module is added/removed, the JS
// bundle compiled for the new native module set is INCOMPATIBLE with
// any APK in the field that doesn't include those modules — calling
// a missing native binding crashes the app at the bridge below any
// JS try/catch. The mitigation is to BUMP versionCode in the same
// commit, which invalidates the prior OTA namespace cleanly.
//
// Incident: commit cfc7c0f (2026-05-10) removed expo-linking without
// bumping versionCode. The bundle published to runtime "1" then
// tried to call expo-linking on devices that still had the
// pre-removal APK with expo-linking native code present — the
// reverse direction (JS no longer imports it but APK has it) is
// non-fatal, but the contaminated bundle ID
// ab09ba56-42aa-4f05-bb83-5013bb7f7a90 also called other modules
// that diverged, and the app crashed past splash. See the OTA
// freeze flag (backend) + versionCode bump (1→2) that recovered.
//
// HOW IT WORKS
// ------------
// 1. Read previous commit's staff-app/package.json via
//    `git show HEAD~1:staff-app/package.json`. Requires checkout
//    fetch-depth >= 2.
// 2. Read current staff-app/package.json.
// 3. Diff dependencies + devDependencies, filtered through the
//    NATIVE allowlist below.
// 4. If any native dep was added/removed, parse versionCode from
//    HEAD~1 vs HEAD app.config.js and compare.
// 5. Native dep changed but versionCode unchanged → exit 1.
// 6. Otherwise → exit 0.
//
// Node stdlib only. No npm install needed in CI.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();
const PKG_PATH = path.join('staff-app', 'package.json');
const CFG_PATH = path.join('staff-app', 'app.config.js');

// Anything that ships a Java/Kotlin/ObjC binding falls into one of
// these prefixes. The list is intentionally over-broad — a few
// pure-JS expo-* modules (expo-constants, expo-asset) will trip the
// guard, but the cost is one versionCode bump on a pass that doesn't
// strictly need it, which is cheap. The reverse failure mode (a real
// native module slipping through) is what we're guarding against.
//
// Add explicit names below when a new vendor lib lands. Avoid removal —
// a name that USED to need versionCode protection but no longer does
// is harmless to leave in the allowlist; removal that frees a real
// native module from the check is silent and dangerous.
const NATIVE_PREFIXES = [
  'expo-',
  'react-native-',
  '@react-native-',
  '@expo/',
  '@sentry/',
  '@firebase/',
];
const NATIVE_EXACT = new Set([
  'firebase',
  'sentry',
  'react-native', // the runtime itself
  '@react-native-community/cli',
]);

function isNativeDep(name) {
  if (NATIVE_EXACT.has(name)) return true;
  return NATIVE_PREFIXES.some((p) => name.startsWith(p));
}

function readPkg(ref) {
  // ref = 'HEAD' | 'HEAD~1' | etc.  When ref === null read working tree.
  let raw;
  if (ref == null) {
    raw = fs.readFileSync(path.join(REPO_ROOT, PKG_PATH), 'utf8');
  } else {
    try {
      raw = execSync(`git show ${ref}:${PKG_PATH}`, { encoding: 'utf8' });
    } catch (err) {
      // Most likely "fatal: invalid object name 'HEAD~1'" — fetch-depth=1.
      die(
        `Could not read ${PKG_PATH} at ${ref}.\n` +
        `If running in CI, ensure actions/checkout uses fetch-depth >= 2.\n` +
        `Underlying error: ${err.message}`,
      );
    }
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`Failed to parse ${PKG_PATH} at ${ref || 'HEAD'}: ${err.message}`);
  }
}

function nativeDepKeys(pkg) {
  const keys = new Set();
  for (const block of [pkg.dependencies, pkg.devDependencies]) {
    if (!block) continue;
    for (const name of Object.keys(block)) {
      if (isNativeDep(name)) keys.add(name);
    }
  }
  return keys;
}

function readVersionCode(ref) {
  let raw;
  if (ref == null) {
    raw = fs.readFileSync(path.join(REPO_ROOT, CFG_PATH), 'utf8');
  } else {
    try {
      raw = execSync(`git show ${ref}:${CFG_PATH}`, { encoding: 'utf8' });
    } catch (err) {
      die(
        `Could not read ${CFG_PATH} at ${ref}.\n` +
        `Underlying error: ${err.message}`,
      );
    }
  }
  // app.config.js is JS, not JSON. Regex-extract the versionCode
  // literal — anchored to `versionCode:` to avoid matching the
  // string "versionCode" in a comment.
  const match = /versionCode\s*:\s*(\d+)/.exec(raw);
  if (!match) {
    die(`Could not find versionCode in ${CFG_PATH} at ${ref || 'HEAD'}`);
  }
  return parseInt(match[1], 10);
}

function die(msg) {
  process.stderr.write(`\n[native-deps-guard] FATAL: ${msg}\n`);
  process.exit(1);
}

function main() {
  const prev = readPkg('HEAD~1');
  const curr = readPkg(null);

  const prevNative = nativeDepKeys(prev);
  const currNative = nativeDepKeys(curr);

  const added = [...currNative].filter((k) => !prevNative.has(k));
  const removed = [...prevNative].filter((k) => !currNative.has(k));

  if (added.length === 0 && removed.length === 0) {
    process.stdout.write('[native-deps-guard] no native dependency changes — versionCode bump not required\n');
    process.exit(0);
  }

  const prevVC = readVersionCode('HEAD~1');
  const currVC = readVersionCode(null);

  if (currVC > prevVC) {
    process.stdout.write(
      `[native-deps-guard] native deps changed AND versionCode bumped ${prevVC} → ${currVC} — OK\n` +
      `  added:   ${added.length ? added.join(', ') : '(none)'}\n` +
      `  removed: ${removed.length ? removed.join(', ') : '(none)'}\n`,
    );
    process.exit(0);
  }

  // FAIL.
  process.stderr.write(
    '\n[native-deps-guard] FAIL: native dependency change without versionCode bump.\n' +
    '\n' +
    `  staff-app/package.json native deps changed in this commit:\n` +
    `    added:   ${added.length ? added.join(', ') : '(none)'}\n` +
    `    removed: ${removed.length ? removed.join(', ') : '(none)'}\n` +
    '\n' +
    `  staff-app/app.config.js android.versionCode:\n` +
    `    HEAD~1: ${prevVC}\n` +
    `    HEAD:   ${currVC}  ← must be > ${prevVC}\n` +
    '\n' +
    '  WHY THIS MATTERS\n' +
    '  ────────────────\n' +
    '  staff-app pins runtimeVersion to nativeVersion (= android.versionCode).\n' +
    '  Without bumping versionCode, the new JS bundle gets published into the\n' +
    '  SAME OTA namespace as devices running the OLD APK. The old APK does not\n' +
    '  have the new native binding (or has a stale one that was removed in JS),\n' +
    '  so on bundle execution the JS bridge calls a missing native method and\n' +
    '  the app crashes past splash with no JS catch reachable.\n' +
    '\n' +
    '  This is what bit commit cfc7c0f (2026-05-10, expo-linking removal).\n' +
    '  Recovery required versionCode 1→2 + an OTA freeze flag for runtime "1".\n' +
    '\n' +
    '  FIX\n' +
    '  ───\n' +
    '  In staff-app/app.config.js, bump:\n' +
    '      android: { versionCode: ' + currVC + ', ... }   →  versionCode: ' + (currVC + 1) + '\n' +
    '  Also bump the human-readable `version` field by patch (e.g. 1.0.1 → 1.0.2)\n' +
    '  so users see the version change after reinstall.\n',
  );
  process.exit(1);
}

main();
