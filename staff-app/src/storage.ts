// SecureStore wrapper for the two credential keys we persist. Token and
// restaurant info are small, so SecureStore is fine — no need to split
// into AsyncStorage.

import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'gb_staff_token';
const REST_KEY = 'gb_staff_restaurant';
const DEVICE_KEY = 'gb_staff_device_id';

export type StoredRestaurant = {
  id: string;
  name?: string;
  slug?: string;
  logo_url?: string | null;
};

export async function saveAuth(token: string, restaurant: StoredRestaurant): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(REST_KEY, JSON.stringify(restaurant));
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function getRestaurant(): Promise<StoredRestaurant | null> {
  const raw = await SecureStore.getItemAsync(REST_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredRestaurant; } catch { return null; }
}

export async function clearAuth(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(REST_KEY);
}

export async function getDeviceId(): Promise<string | null> {
  return SecureStore.getItemAsync(DEVICE_KEY);
}

export async function setDeviceId(id: string): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_KEY, id);
}

// Best-effort JWT exp check. Does NOT verify signature — we rely on the
// server to reject forged tokens. This is only to avoid hitting the API
// with a token we already know is expired.
export function isTokenExpired(token: string | null | undefined): boolean {
  if (!token) return true;
  const parts = token.split('.');
  if (parts.length !== 3) return true;
  try {
    const payload = JSON.parse(
      // React Native has atob; fall back to Buffer if not.
      typeof atob === 'function'
        ? atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
        : Buffer.from(parts[1], 'base64').toString('utf-8')
    );
    if (!payload.exp) return false;
    return Date.now() / 1000 >= payload.exp;
  } catch {
    return true;
  }
}
