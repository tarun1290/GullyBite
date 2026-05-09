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
// Per-session branch selection — survives app restarts so the
// operator doesn't have to re-pick the branch on every cold start.
// Distinct from the JWT's `branchId` (the LOGIN branch — the staff
// access token's branch), which is the immutable primary. The selection
// can be 'all' (multi-branch view) or any id from the JWT's branch_ids.
const CURRENT_BRANCH_KEY = 'gb_current_branch_id';

// 'manager' was added 2026-05-09 alongside the backend /api/staff/auth
// role-filter widening (role: { $in: ['staff', 'manager'] }). Managers
// log in through the same staff-app flow as staff but see additional
// sections (branch toggle, daily summary, etc.) gated by useRole.
// 'owner' is the separate owner-login path.
export type UserRole = 'staff' | 'manager' | 'owner';

export type StoredRestaurant = {
  id: string;
  name?: string;
  slug?: string;
  logo_url?: string | null;
};

export type StoredBranch = {
  id: string;
  name: string;
};

export type StoredStaffUser = {
  userId: string;
  name: string;
  branchId: string;
  // role is sourced from /api/staff/auth's staffUser response. Optional
  // because legacy installs (pre-role-in-response) may have a staff_info
  // row written before the field was added — authStore back-fills with
  // the separately-stored gb_user_role key so existing sessions keep
  // working without forcing a re-login.
  role?: UserRole;
  // Multi-branch additions (2026-05-09). Both optional for back-compat
  // with sessions persisted before the response started carrying the
  // arrays — authStore falls back to [branchId] when absent so the
  // selector still renders correctly even on legacy data.
  branchIds?: string[];
  branches?: StoredBranch[];
  permissions: Record<string, boolean>;
};

// Branch selector value. 'all' means multi-branch (every assigned
// branch); any other string is a specific branch id from branchIds.
export type CurrentBranchSelection = string | 'all';

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
  if (raw === 'staff' || raw === 'manager' || raw === 'owner') return raw;
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

export async function saveCurrentBranch(value: CurrentBranchSelection): Promise<void> {
  await SecureStore.setItemAsync(CURRENT_BRANCH_KEY, String(value));
}

export async function getCurrentBranch(): Promise<CurrentBranchSelection | null> {
  const raw = await SecureStore.getItemAsync(CURRENT_BRANCH_KEY);
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

export async function clearAuth(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(REST_KEY);
  await SecureStore.deleteItemAsync(STAFF_KEY);
  // New role/owner/branch keys may not have been written on first logout —
  // catch so a clean install + immediate logout doesn't surface a
  // SecureStore error.
  await SecureStore.deleteItemAsync(ROLE_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(OWNER_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(CURRENT_BRANCH_KEY).catch(() => {});
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
