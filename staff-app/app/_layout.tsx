// Root layout. Three jobs:
//   1. Mount the AuthProvider so screens can subscribe to auth state.
//   2. Parse incoming deep links / Universal Links of the shape
//      gullybite-staff://staff/<staff_access_token>
//      https://gullybite.duckdns.org/staff/<staff_access_token>
//      and stash the token under AsyncStorage 'pending_staff_access_token'
//      so login.tsx can pick it up. If the user is already signed in,
//      we ignore the deep link (their tablet is already authenticated).
//   3. Route guard — redirect to /login or /(app)/orders based on auth.

import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import * as Updates from 'expo-updates';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AuthProvider, useAuth } from '@/store/authStore';
import { setupNotificationHandler } from '@/push';
import { colors } from '@/theme';

const PENDING_TOKEN_KEY = 'pending_staff_access_token';

// Parse the staff_access_token segment out of any URL of the shape
//   .../staff/<token> (with optional query / hash trailing)
// Returns null if the URL doesn't match the staff-link pattern.
function extractTokenFromUrl(url: string | null): string | null {
  if (!url) return null;
  // Examples:
  //   gullybite-staff://staff/abc-123
  //   https://gullybite.duckdns.org/staff/abc-123
  //   https://gully-bite.vercel.app/staff/abc-123?source=qr
  const match = url.match(/\/staff\/([^/?#]+)/);
  if (!match) return null;
  const token = match[1];
  // Sanity: token should look like a UUID. Don't be strict — server
  // does the real validation. Just reject obviously bogus segments.
  if (!token || token.length < 4 || token.length > 100) return null;
  return token;
}

function RootInner() {
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const segments = useSegments();
  const { token, role, isLoading: authLoading } = useAuth();
  const notifListener = useRef<Notifications.EventSubscription | null>(null);

  useEffect(() => {
    (async () => {
      await setupNotificationHandler();
      setReady(true);
    })();
  }, []);

  // ─── Deep-link handler ─────────────────────────────────────
  // Pull initial URL (cold start) + subscribe to live URLs (warm).
  // Stash the token under PENDING_TOKEN_KEY for login.tsx. Authenticated
  // sessions ignore incoming links — switching staff requires explicit
  // logout first.
  useEffect(() => {
    let cancelled = false;
    let sub: { remove: () => void } | null = null;

    const handleUrl = async (url: string | null) => {
      if (cancelled) return;
      const tok = extractTokenFromUrl(url);
      if (!tok) return;
      if (token) return; // already authenticated — ignore link
      try { await AsyncStorage.setItem(PENDING_TOKEN_KEY, tok); } catch { /* noop */ }
      // If we're not at /login already, kick the route guard there.
      const seg0 = segments[0];
      if (seg0 !== 'login') router.replace('/login');
    };

    (async () => {
      const initial = await Linking.getInitialURL();
      await handleUrl(initial);
    })();
    sub = Linking.addEventListener('url', (event) => handleUrl(event.url));

    return () => {
      cancelled = true;
      try { sub?.remove(); } catch { /* noop */ }
    };
  }, [token, router, segments]);

  // ─── Route guard ──────────────────────────────────────────
  // Re-runs on every segment change so a logout (which navigates to
  // /login) doesn't get bounced back into (app).
  // Role-aware: owner JWTs route to (owner), staff JWTs (and legacy
  // pre-role-key sessions where role hydrates as null but a staffUser
  // exists — handled in authStore HYDRATED) route to (app).
  useEffect(() => {
    if (!ready || authLoading) return;
    const authed = !!token;
    const inAppGroup = segments[0] === '(app)';
    const inOwnerGroup = segments[0] === '(owner)';
    const atLogin = segments[0] === 'login';
    const atOwnerLogin = segments[0] === 'owner-login';
    const atAuthScreen = atLogin || atOwnerLogin;
    if (!authed && !atAuthScreen) router.replace('/login');
    else if (authed && role === 'owner' && !inOwnerGroup) router.replace('/(owner)/dashboard');
    else if (authed && role !== 'owner' && !inAppGroup && !atLogin) router.replace('/(app)/orders');
  }, [ready, authLoading, token, role, segments, router]);

  // Tap-to-open routing. Five payload shapes today:
  //   • new_order        — staff: orders queue; owner: dashboard
  //   • settlement_paid  — owner-only: dashboard (totals card surfaces it)
  //   • branch_paused    — owner-only: branches list (where the retry
  //                                     CTA on the paused row lives)
  //   • daily_summary    — owner-only: dashboard
  // Owner-only payloads are no-ops on staff sessions; the backend
  // gates them behind owner_push_tokens registration so a staff-only
  // device shouldn't receive them in the first place.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const type = (resp?.notification?.request?.content?.data as any)?.type;
      if (type === 'new_order') {
        if (role === 'owner') router.navigate('/(owner)/dashboard');
        else router.navigate('/(app)/orders');
      } else if (type === 'settlement_paid') {
        router.navigate('/(owner)/dashboard');
      } else if (type === 'branch_paused') {
        router.navigate('/(owner)/branches');
      } else if (type === 'daily_summary') {
        router.navigate('/(owner)/dashboard');
      }
    });
    notifListener.current = sub;
    return () => {
      try { sub.remove(); } catch { /* noop */ }
    };
  }, [router, role]);

  // ─── Self-hosted OTA check (silent, fire-and-forget) ───────
  // Runs once on mount. Updates.isEnabled gates dev mode (where
  // Updates is a no-op stub) so this is safe to call locally too.
  // Wrapped in try/catch — a network blip / 5xx must NOT brick the
  // app. checkForUpdateAsync hits /api/ota/manifest with the
  // expo-runtime-version + expo-platform headers; if the backend
  // returns 204 (no active update) result.isAvailable is false and
  // we no-op. If a fresh bundle is available, fetchUpdateAsync pulls
  // the assets and reloadAsync swaps in the new bundle on the next
  // foreground tick.
  useEffect(() => {
    if (!Updates.isEnabled) return;
    (async () => {
      try {
        const result = await Updates.checkForUpdateAsync();
        if (result.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      } catch {
        /* silent — never crash the app over an OTA failure */
      }
    })();
  }, []);

  if (!ready || authLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.ink }}>
        <ActivityIndicator color={colors.acc} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="owner-login" />
      <Stack.Screen name="(app)" />
      <Stack.Screen name="(owner)" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <AuthProvider>
          <RootInner />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
