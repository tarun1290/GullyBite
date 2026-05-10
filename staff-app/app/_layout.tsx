// Root layout. Two jobs:
//   1. Mount the StaffProvider so screens can subscribe to session
//      state via useStaff() (token, role, staff record, permissions,
//      branch selection, owner identity).
//   2. Route guard — redirect to /login or /(app)/orders based on auth.
//
// Part 6b cleanup (2026-05-10): the legacy deep-link handler that
// parsed gullybite-staff://staff/<staff_access_token> URLs and stashed
// the token under AsyncStorage 'pending_staff_access_token' was removed.
// The current login flow uses store_slug + staff_id + pin (see
// app/login.tsx) and nothing reads pending_staff_access_token any more.
//
// Part 6c unification (2026-05-10): the previously-separate AuthProvider
// (src/store/authStore.tsx) was folded into StaffProvider, collapsing
// the dual auth/staff context into a single provider with one logout
// path. authStore.tsx is gone; useStaff() exposes everything formerly
// behind useAuth().

import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { StaffProvider, useStaff } from '@/state/StaffContext';
import { setupNotificationHandler } from '@/push';
import { colors } from '@/theme';

function RootInner() {
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const segments = useSegments();
  const { token, role, isLoading: authLoading } = useStaff();
  const notifListener = useRef<Notifications.EventSubscription | null>(null);

  useEffect(() => {
    (async () => {
      await setupNotificationHandler();
      setReady(true);
    })();
  }, []);

  // ─── Route guard ──────────────────────────────────────────
  // Re-runs on every segment change so a logout (which navigates to
  // /login) doesn't get bounced back into (app).
  // Role routing (2026-05-09 update — added 'manager'):
  //   owner   → /(owner)/dashboard  (full management surface)
  //   manager → /(owner)/dashboard  (same screens; manager-only
  //                                   sub-sections gated via useRole
  //                                   for future-proofing)
  //   staff   → /(app)/orders       (operational subset only)
  //   null    → /(app)/orders       (legacy session — authStore
  //                                   HYDRATED defaults to 'staff')
  useEffect(() => {
    if (!ready || authLoading) return;
    const authed = !!token;
    const inAppGroup = segments[0] === '(app)';
    const inOwnerGroup = segments[0] === '(owner)';
    const atLogin = segments[0] === 'login';
    const atOwnerLogin = segments[0] === 'owner-login';
    const atAuthScreen = atLogin || atOwnerLogin;
    const isManagerLike = role === 'owner' || role === 'manager';
    if (!authed && !atAuthScreen) router.replace('/login');
    else if (authed && isManagerLike && !inOwnerGroup) router.replace('/(owner)/dashboard');
    else if (authed && !isManagerLike && !inAppGroup && !atLogin) router.replace('/(app)/orders');
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
      const data = (resp?.notification?.request?.content?.data as any) || {};
      const type = data?.type;
      if (type === 'new_order') {
        if (role === 'owner') {
          router.navigate('/(owner)/dashboard');
        } else {
          // Deep-link to the per-order detail when the push payload
          // carries an order id (added 2026-05-09 — backend
          // sseListener attaches order_id + branch_id on every
          // order.created push). Falls back to the orders list for
          // legacy payloads or test pushes that omit the id.
          const orderId = typeof data?.order_id === 'string' ? data.order_id : '';
          if (orderId) {
            router.navigate(`/(app)/orders/${encodeURIComponent(orderId)}`);
          } else {
            router.navigate('/(app)/orders');
          }
        }
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
        {/* StaffProvider is the single source of truth for the
            authenticated session — token, role, restaurant, owner
            identity, multi-branch selection, AND the sanitized /me
            staff record + permission map. It exposes useStaff() (and a
            useIsAuthenticated() helper). The legacy AuthProvider /
            useAuth surface was folded in during Part 6c; consumers
            should call useStaff() directly. */}
        <StaffProvider>
          <RootInner />
        </StaffProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
