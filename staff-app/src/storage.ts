// SecureStore wrapper for credential keys. Token + restaurant + staff
// user info are small, so SecureStore is fine — no need to split into
// AsyncStorage. The `staff_info` key holds branchId + permissions,
// mirroring what's encoded in the JWT, so the auth store can hydrate
// without parsing the token.

import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'gb_staff_token';
const REST_KEY = 'gb_staff_restaurant';
const STAFF_KEY = 'gb_staff_info';
const DEVICE_KEY = 'gb_staff_device_id';
const ROLE_KEY = 'gb_user_role';
const OWNER_KEY = 'gb_owner_info';

export type UserRole = 'staff' | 'owner';

export type StoredRestaurant = {
  id: string;
  name?: string;
  slug?: string;
  logo_url?: string | null;
};

export type StoredStaffUser = {
  userId: string;
  name: string;
  branchId: string;
  permissions: Record<string, boolean>;
};

export type StoredOwnerInfo = {
  restaurantId: string;
  name: string;
};

export async function saveAuth(
  token: string,
  restaurant: StoredRestaurant,
  staff?: StoredStaffUser,
): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(REST_KEY, JSON.stringify(restaurant));
  if (staff) await SecureStore.setItemAsync(STAFF_KEY, JSON.stringify(staff));
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function getRestaurant(): Promise<StoredRestaurant | null> {
  const raw = await SecureStore.getItemAsync(REST_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredRestaurant; } catch { return null; }
}

export async function getStaffInfo(): Promise<StoredStaffUser | null> {
  const raw = await SecureStore.getItemAsync(STAFF_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredStaffUser; } catch { return null; }
}

export async function saveRole(role: UserRole): Promise<void> {
  await SecureStore.setItemAsync(ROLE_KEY, role);
}

export async function getRole(): Promise<UserRole | null> {
  const raw = await SecureStore.getItemAsync(ROLE_KEY);
  if (raw === 'staff' || raw === 'owner') return raw;
  return null;
}

export async function saveOwnerInfo(info: StoredOwnerInfo): Promise<void> {
  await SecureStore.setItemAsync(OWNER_KEY, JSON.stringify(info));
}

export async function getOwnerInfo(): Promise<StoredOwnerInfo | null> {
  const raw = await SecureStore.getItemAsync(OWNER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredOwnerInfo; } catch { return null; }
}

export async function clearAuth(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(REST_KEY);
  await SecureStore.deleteItemAsync(STAFF_KEY);
  // New role/owner keys may not have been written on first logout — catch
  // so a clean install + immediate logout doesn't surface a SecureStore error.
  await SecureStore.deleteItemAsync(ROLE_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(OWNER_KEY).catch(() => {});
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
