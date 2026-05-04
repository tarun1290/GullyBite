// Expo dynamic config — reads build-time env vars so the APK embeds the
// correct backend URL. EXPO_PUBLIC_API_URL is required; default applies
// only for local dev. Bundle id and version are fixed here.
//
// ─── post-prebuild signing patch ────────────────────────────────────
// `expo prebuild` does NOT support a `hooks.postPrebuild` field in
// app.config.js — that's an EAS Build concept. To run the
// release-signingConfig injection (scripts/patch-gradle-signing.js)
// after Android scaffolding is generated, we use TWO mechanisms:
//
//   1. package.json npm lifecycle (`prebuild` + `postprebuild`) — fires
//      automatically when developers run `npm run prebuild` locally.
//   2. An explicit step in the GitHub Actions workflow
//      (.github/workflows/build-android-staff.yml) — fires after
//      `npx expo prebuild`, which does NOT trigger npm lifecycles.
//
// Both paths run the same script; the patch script itself is
// idempotent so accidental double-runs are safe.
//
// ─── package-lock sync reminder ─────────────────────────────────────
// After adding/removing any dependency in package.json (e.g.
// expo-updates, expo-build-properties), run `npm install` in
// staff-app/ locally to refresh package-lock.json before pushing.
// GitHub Actions runs `npm ci`, which fails fast if lockfile and
// package.json drift. `npm install --package-lock-only` is enough.

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://gullybite.duckdns.org';
const PROJECT_ID = process.env.EXPO_PUBLIC_PROJECT_ID || '';

module.exports = ({ config }) => ({
  ...config,
  name: 'GullyBite Staff',
  slug: 'gullybite-staff',
  scheme: 'gullybite-staff',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#4338ca',
  },
  assetBundlePatterns: ['**/*'],
  android: {
    package: 'com.gullybite.staff',
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#4338ca',
    },
    permissions: [
      'android.permission.INTERNET',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.VIBRATE',
    ],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-updates',
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: '#4338ca',
      },
    ],
    // Pin Kotlin to 1.9.25 across all expo modules. Required because
    // Compose Compiler 1.5.x bundled with SDK 52 rejects Kotlin 1.9.24
    // (the default), crashing expo-modules-core:compileReleaseKotlin.
    // The official build-properties plugin propagates the override to
    // every module via the generated android/gradle.properties; a
    // raw gradle.properties patch in postprebuild does not (modules
    // resolve their own toolchain). Update this in lockstep with any
    // Compose-aware library bump.
    [
      'expo-build-properties',
      { android: { kotlinVersion: '1.9.25' } },
    ],
  ],
  // Self-hosted OTA. Manifest is served by the GullyBite backend at
  // /api/ota/manifest (see backend/src/routes/otaUpdates.js). Runtime
  // sends `expo-runtime-version` + `expo-platform` headers; the policy
  // below pins runtimeVersion to the native android.versionCode (a
  // bundle compiled against versionCode N is only delivered to APKs
  // with the matching versionCode), so a JS-only OTA can never fight
  // a native-binary mismatch. Bump versionCode to invalidate the OTA
  // channel cleanly.
  runtimeVersion: { policy: 'nativeVersion' },
  updates: {
    enabled: true,
    checkAutomatically: 'ON_LOAD',
    fallbackToCacheTimeout: 0,
    url: `${API_URL}/api/ota/manifest`,
  },
  extra: {
    apiUrl: API_URL,
    eas: PROJECT_ID ? { projectId: PROJECT_ID } : undefined,
  },
  experiments: {
    typedRoutes: true,
  },
});
