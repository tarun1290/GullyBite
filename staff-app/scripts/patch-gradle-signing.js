#!/usr/bin/env node
'use strict';

// Post-prebuild patch: injects a release signing config into
// android/app/build.gradle. The four values come from -P Gradle
// properties (keystorePath, keystorePassword, keyAlias, keyPassword)
// which the GitHub Actions workflow supplies from repo secrets.
//
// Idempotent: if the marker is already present the file is left alone.

const fs = require('fs');
const path = require('path');

const GRADLE_PATH = path.join(__dirname, '..', 'android', 'app', 'build.gradle');
const MARKER = '// gullybite-signing-patched';

const SIGNING_BLOCK = `
    ${MARKER}
    signingConfigs {
        release {
            if (project.hasProperty('keystorePath')) {
                storeFile file(project.findProperty('keystorePath'))
                storePassword project.findProperty('keystorePassword')
                keyAlias project.findProperty('keyAlias')
                keyPassword project.findProperty('keyPassword')
            }
        }
    }
`;

function die(msg) {
  console.error(`[patch-gradle-signing] ${msg}`);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(GRADLE_PATH)) {
    console.warn(
      '[patch-gradle-signing] android/app/build.gradle not found — run `npx expo prebuild --platform android` first.'
    );
    return;
  }

  let src = fs.readFileSync(GRADLE_PATH, 'utf8');

  if (src.includes(MARKER)) {
    console.log('[patch-gradle-signing] already patched; skipping.');
    return;
  }

  // Step 1 — insert signingConfigs block just inside `android { ... }`.
  const androidMatch = src.match(/\nandroid\s*\{\s*\n/);
  if (!androidMatch) die('could not find `android { ... }` block in build.gradle');
  const insertAt = androidMatch.index + androidMatch[0].length;
  src = src.slice(0, insertAt) + SIGNING_BLOCK + src.slice(insertAt);

  // Step 2 — point buildTypes.release at signingConfigs.release. We
  // look for the existing `release { ... signingConfig signingConfigs.debug }`
  // the Expo template writes and swap the debug ref for release.
  const DEBUG_SIG_RE = /signingConfig\s+signingConfigs\.debug/;
  if (DEBUG_SIG_RE.test(src)) {
    src = src.replace(DEBUG_SIG_RE, 'signingConfig signingConfigs.release');
  } else if (!/signingConfig\s+signingConfigs\.release/.test(src)) {
    // No existing signingConfig line — try to inject inside buildTypes.release.
    const RELEASE_RE = /(buildTypes\s*\{[\s\S]*?release\s*\{\s*\n)/;
    if (!RELEASE_RE.test(src)) die('could not find buildTypes.release block to attach signing');
    src = src.replace(RELEASE_RE, (m) => `${m}            signingConfig signingConfigs.release\n`);
  }

  fs.writeFileSync(GRADLE_PATH, src);
  console.log('[patch-gradle-signing] applied signing config to android/app/build.gradle');
}

try { main(); } catch (err) {
  die(err && err.stack ? err.stack : String(err));
}
