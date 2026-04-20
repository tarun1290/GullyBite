import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { getToken, isTokenExpired } from '@/storage';
import { setupNotificationHandler } from '@/push';
import { colors } from '@/theme';

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const segments = useSegments();
  const notifListener = useRef<Notifications.EventSubscription | null>(null);

  useEffect(() => {
    (async () => {
      await setupNotificationHandler();
      setReady(true);
    })();
  }, []);

  // Route guard — re-reads token on every segment change so that logout
  // (which navigates to /login) doesn't get bounced back to (tabs).
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const token = await getToken();
      const authed = !!token && !isTokenExpired(token);
      if (cancelled) return;
      const inAuthGroup = segments[0] === '(tabs)';
      const atLogin = segments[0] === 'login';
      if (!authed && !atLogin) router.replace('/login');
      else if (authed && !inAuthGroup && !atLogin) router.replace('/(tabs)/orders');
    })();
    return () => { cancelled = true; };
  }, [ready, segments, router]);

  // Navigate to Orders when a new_order push is tapped.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const type = (resp?.notification?.request?.content?.data as any)?.type;
      if (type === 'new_order') {
        router.navigate('/(tabs)/orders');
      }
    });
    notifListener.current = sub;
    return () => {
      try { sub.remove(); } catch { /* noop */ }
    };
  }, [router]);

  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.ink }}>
        <ActivityIndicator color={colors.acc} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="login" />
          <Stack.Screen name="(tabs)" />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
