// Expo push registration. Called after login. Silently no-ops on
// emulators / denied permissions so the rest of the app keeps working.

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { registerOwnerPushToken, registerPushToken } from './api';
import { ensureDeviceId } from './deviceId';

export async function setupNotificationHandler(): Promise<void> {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('orders', {
      name: 'New Orders',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
      lightColor: '#4338ca',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    // Owner-only channels. Created on every device so a staff phone
    // that later signs in as owner doesn't need a fresh install to
    // receive these. Android doesn't surface unused channels in
    // Settings → Notifications until they fire at least once.
    await Notifications.setNotificationChannelAsync('settlements', {
      name: 'Settlement Payouts',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    });
    await Notifications.setNotificationChannelAsync('alerts', {
      name: 'Branch Alerts',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
    });
    await Notifications.setNotificationChannelAsync('summary', {
      name: 'Daily Summary',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    });
  }
}

export async function requestPermissionsAndRegister(): Promise<string | null> {
  if (!Device.isDevice) {
    // Emulators don't get FCM tokens; skip silently.
    return null;
  }
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const asked = await Notifications.requestPermissionsAsync();
    status = asked.status;
  }
  if (status !== 'granted') return null;

  const projectId =
    (Constants.expoConfig?.extra as any)?.eas?.projectId ||
    (Constants.easConfig as any)?.projectId ||
    undefined;

  let token: string | null = null;
  try {
    const res = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    token = res.data || null;
  } catch (err) {
    // Missing projectId in dev is non-fatal — log and move on.
    console.warn('[push] getExpoPushTokenAsync failed:', (err as Error).message);
    return null;
  }

  if (!token) return null;

  const deviceId = await ensureDeviceId();
  try {
    await registerPushToken(token, deviceId);
  } catch (err) {
    console.warn('[push] register failed:', (err as Error).message);
  }
  return token;
}

// Owner-mobile counterpart of requestPermissionsAndRegister. Identical
// flow (permission prompt → Expo token → backend register) but POSTs
// to /api/restaurant/owner/push-token under the owner JWT so the token
// lands in restaurants.owner_push_tokens, not push_tokens. Same silent
// fail-modes — emulator without FCM, denied permission, missing
// projectId in dev — return null without throwing so the caller can
// fire-and-forget without disrupting login navigation.
export async function requestOwnerPermissionsAndRegister(): Promise<string | null> {
  if (!Device.isDevice) {
    return null;
  }
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const asked = await Notifications.requestPermissionsAsync();
    status = asked.status;
  }
  if (status !== 'granted') return null;

  const projectId =
    (Constants.expoConfig?.extra as any)?.eas?.projectId ||
    (Constants.easConfig as any)?.projectId ||
    undefined;

  let token: string | null = null;
  try {
    const res = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    token = res.data || null;
  } catch (err) {
    console.warn('[push] getExpoPushTokenAsync failed:', (err as Error).message);
    return null;
  }

  if (!token) return null;

  const deviceId = await ensureDeviceId();
  try {
    await registerOwnerPushToken(token, deviceId);
  } catch (err) {
    console.warn('[push] owner register failed:', (err as Error).message);
  }
  return token;
}

export async function playLocalNewOrderNotification(title: string, body: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: 'default',
        data: { type: 'new_order' },
        ...(Platform.OS === 'android' ? { channelId: 'orders' } : {}),
      },
      trigger: null,
    });
  } catch (err) {
    console.warn('[push] local notify failed:', (err as Error).message);
  }
}
