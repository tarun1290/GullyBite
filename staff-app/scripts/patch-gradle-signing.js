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

// Pinned Kotlin version for the Compose Compiler / Kotlin compatibility
// matrix. SDK 52's default is too new for the bundled compiler and the
// release build crashes at compile time. 1.9.25 is the highest stable
// Kotlin that Compose Compiler 1.5.x accepts. Update this together
// with any Compose-aware library bump.
const GRADLE_PROPERTIES_PATH = path.join(__dirname, '..', 'android', 'gradle.properties');
const KOTLIN_VERSION_LINE = 'kotlinVersion=1.9.25';

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

// Idempotent patch for android/gradle.properties — pins kotlinVersion
// to fix the Compose Compiler / Kotlin mismatch that crashes
// assembleRelease. Mirrors the build.gradle patch's missing-file
// posture: if the file isn't there yet (script run before prebuild),
// warn and bail rather than crash. Wrapped in try/catch at the call
// site so any read/write failure also degrades to a warning.
function patchGradleProperties() {
  if (!fs.existsSync(GRADLE_PROPERTIES_PATH)) {
    console.warn(
      '[patch-gradle-signing] android/gradle.properties not found — run `npx expo prebuild --platform android` first.'
    );
    return;
  }

  const src = fs.readFileSync(GRADLE_PROPERTIES_PATH, 'utf8');

  // Idempotent: if the exact target line is already present, no-op
  // silently. Split-and-includes handles trailing whitespace and
  // arbitrary line positions without needing a multiline regex.
  const lines = src.split('\n');
  if (lines.includes(KOTLIN_VERSION_LINE)) {
    return;
  }

  let next;
  // Replace any existing kotlinVersion= line (different value).
  // ^...$ with /m so we anchor to start-of-line, not start-of-file.
  const KOTLIN_LINE_RE = /^kotlinVersion=.*$/m;
  if (KOTLIN_LINE_RE.test(src)) {
    next = src.replace(KOTLIN_LINE_RE, KOTLIN_VERSION_LINE);
  } else {
    // No existing line — append at the end. Preserve trailing newline
    // discipline so we don't produce a malformed properties file.
    next = src.endsWith('\n')
      ? `${src}${KOTLIN_VERSION_LINE}\n`
      : `${src}\n${KOTLIN_VERSION_LINE}\n`;
  }

  fs.writeFileSync(GRADLE_PROPERTIES_PATH, next);
  console.log('[patch-gradle-signing] pinned kotlinVersion=1.9.25 in gradle.properties');
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

  // Step 3 — pin kotlinVersion in gradle.properties. Independent of
  // the signing patch but lives here so the GitHub Actions workflow
  // doesn't need a separate step. Own try/catch so a properties-file
  // hiccup never crashes the signing patch.
  try {
    patchGradleProperties();
  } catch (err) {
    console.warn(
      '[patch-gradle-signing] gradle.properties patch failed (non-fatal):',
      err && err.message ? err.message : String(err),
    );
  }

  fs.writeFileSync(GRADLE_PATH, src);
  console.log('[patch-gradle-signing] applied signing config to android/app/build.gradle');
}

try { main(); } catch (err) {
  die(err && err.stack ? err.stack : String(err));
}
