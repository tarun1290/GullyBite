// Expo dynamic config — reads build-time env vars so the APK embeds the
// correct backend URL. EXPO_PUBLIC_API_URL is required; default applies
// only for local dev. Bundle id and version are fixed here.

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
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: '#4338ca',
      },
    ],
  ],
  extra: {
    apiUrl: API_URL,
    eas: PROJECT_ID ? { projectId: PROJECT_ID } : undefined,
  },
  experiments: {
    typedRoutes: true,
  },
});
