// Thin fetch wrapper: reads base URL from app.config extra, attaches the
// staff JWT, surfaces HTTP errors as thrown Error(msg) with the server's
// `error` field when available.

import Constants from 'expo-constants';
import { getToken } from './storage';

const BASE =
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ||
  process.env.EXPO_PUBLIC_API_URL ||
  'https://gullybite.duckdns.org';

export function apiBase(): string {
  return BASE.replace(/\/+$/, '');
}

type FetchOpts = {
  method?: string;
  body?: unknown;
  auth?: boolean; // default true
  headers?: Record<string, string>;
};

async function request<T = unknown>(path: string, opts: FetchOpts = {}): Promise<T> {
  const url = `${apiBase()}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers || {}),
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false) {
    const token = await getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    (err as any).status = res.status;
    throw err;
  }
  return (json as T) ?? ({} as T);
}

// ─── Types (legacy inline shapes — re-exported from src/types.ts) ──────
//
// Kept here for back-compat with the existing UI components that import
// these from '@/api'. The canonical shapes are now in src/types.ts.

export type StaffLoginResponse = {
  token: string;
  restaurant: {
    id: string;
    name?: string;
    slug?: string;
    logo_url?: string | null;
  };
  staffUser: {
    id: string;
    name: string;
    branchId: string;
    permissions: Record<string, boolean>;
  };
};

export type StaffOrderItem = {
  id?: string;
  name?: string;
  qty?: number;
  quantity?: number;
  price_rs?: number;
  price?: number;
};

export type StaffOrder = {
  id: string;
  order_number?: string | null;
  customer_name?: string;
  customer_phone_masked?: string;
  total_rs?: number | null;
  total_amount?: number | null;
  status?: string;
  payment_status?: string | null;
  branch_id?: string | null;
  accepted_at?: string | null;
  created_at?: string;
  items?: StaffOrderItem[];
};

export type StaffMenuItem = {
  id: string;
  name: string;
  price_rs?: number;
  price?: number;
  is_available: boolean;
  category_name?: string;
  category?: string;
  image_url?: string | null;
};

export type StaffMenuResponse = {
  categories: Array<{ name: string; items: StaffMenuItem[] }>;
};

// ─── Endpoints ────────────────────────────────────────────────────────

// Per-user, per-branch login. The staff_access_token is embedded in the
// branch-specific URL the manager sends to the staff member; the staff
// member then enters their name + PIN. Server resolves the token to a
// branch, finds matching staff_users by name (case-insensitive),
// bcrypt-compares the PIN, and signs a JWT carrying branchId.
export async function login(
  staffAccessToken: string,
  name: string,
  pin: string,
): Promise<StaffLoginResponse> {
  return request<StaffLoginResponse>('/api/staff/auth', {
    method: 'POST',
    body: { staff_access_token: staffAccessToken, name, pin },
    auth: false,
  });
}

export async function getOrders(): Promise<{ orders: StaffOrder[] }> {
  return request<{ orders: StaffOrder[] }>('/api/staff/orders');
}

// Accept and decline are RESTAURANT-side endpoints that the new
// `requireStaffOrRestaurantAuth` middleware accepts for staff JWTs too.
// They live under /api/restaurant, not /api/staff — different prefix
// from the rest of the staff endpoints below.
export async function acceptOrder(orderId: string): Promise<{ success: boolean; status: string }> {
  return request(`/api/restaurant/orders/${encodeURIComponent(orderId)}/accept`, {
    method: 'POST',
  });
}

export async function declineOrder(
  orderId: string,
  reason?: string,
): Promise<{ success: boolean; status: string; refundId?: string | null }> {
  return request(`/api/restaurant/orders/${encodeURIComponent(orderId)}/decline`, {
    method: 'POST',
    body: { reason: reason || 'Declined by staff' },
  });
}

// Status update for CONFIRMED → PREPARING and PREPARING → PACKED only.
// Staff cannot transition to DISPATCHED, DELIVERED, or any fault state.
export async function updateOrderStatus(
  orderId: string,
  status: string,
): Promise<{ success: boolean; status: string }> {
  return request(`/api/staff/orders/${encodeURIComponent(orderId)}/status`, {
    method: 'PATCH',
    body: { status },
  });
}

export async function getMenu(): Promise<StaffMenuResponse> {
  return request<StaffMenuResponse>('/api/staff/menu');
}

// Spec'd as PATCH /api/staff/items/:itemId/availability with body
// { available: boolean }. The backend mirrors this at both
// /menu/:id/availability (legacy) and /items/:id/availability (spec) —
// we use the spec'd path. Both `is_available` and `available` are
// accepted by the server; sending `is_available` to match the existing
// menu_items internal field.
export async function toggleItemAvailability(
  itemId: string,
  available: boolean,
): Promise<{ success: boolean; is_available: boolean }> {
  return request(`/api/staff/items/${encodeURIComponent(itemId)}/availability`, {
    method: 'PATCH',
    body: { is_available: available },
  });
}

// Back-compat alias — older callers (existing menu screen) use this name.
export const updateItemAvailability = toggleItemAvailability;

export async function registerPushToken(token: string, deviceId: string): Promise<{ success: boolean }> {
  return request('/api/staff/push-token', {
    method: 'POST',
    body: { token, device_id: deviceId },
  });
}

export async function deregisterPushToken(deviceId: string): Promise<{ success: boolean }> {
  return request('/api/staff/push-token', {
    method: 'DELETE',
    body: { device_id: deviceId },
  });
}

// ─── Owner mobile dashboard ──────────────────────────────────────────
// Distinct token from the staff JWT — signed by /api/restaurant/owner/login
// with role: 'owner', no token_version dependence, 30d expiry. The same
// `request` helper attaches the token via Authorization Bearer; the
// backend's requireOwnerAuth middleware verifies role + restaurantId.

export type OwnerLoginResponse = {
  token: string;
  restaurant: {
    id: string;
    name?: string;
    slug?: string;
    logo_url?: string | null;
  };
};

export async function ownerLogin(
  email: string,
  password: string,
): Promise<OwnerLoginResponse> {
  return request<OwnerLoginResponse>('/api/restaurant/owner/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
  });
}

export async function getOwnerDashboard(): Promise<{
  restaurant: { id: string; name: string; slug: string };
  branches: Array<{
    id: string;
    name: string;
    is_open: boolean;
    accepts_orders: boolean;
    subscription_status: string;
    today_orders: number;
    today_revenue_rs: number;
  }>;
  totals: {
    today_orders: number;
    today_revenue_rs: number;
    active_branches: number;
    paused_branches: number;
  };
}> {
  return request('/api/restaurant/owner/dashboard');
}

export async function toggleBranchOpen(
  branchId: string,
  is_open: boolean,
): Promise<{ ok: boolean; is_open: boolean }> {
  return request(`/api/restaurant/owner/branches/${encodeURIComponent(branchId)}/toggle-open`, {
    method: 'PATCH',
    body: { is_open },
  });
}

export async function toggleItemStock(
  itemId: string,
  is_available: boolean,
): Promise<{ ok: boolean; is_available: boolean }> {
  return request(`/api/restaurant/owner/items/${encodeURIComponent(itemId)}/stock`, {
    method: 'PATCH',
    body: { is_available },
  });
}

export async function getOwnerBranchMenu(branchId: string): Promise<StaffMenuResponse> {
  return request<StaffMenuResponse>(
    `/api/restaurant/owner/branches/${encodeURIComponent(branchId)}/menu`,
  );
}

export async function registerOwnerPushToken(
  token: string,
  deviceId: string,
): Promise<{ ok: boolean }> {
  return request('/api/restaurant/owner/push-token', {
    method: 'POST',
    body: { token, device_id: deviceId },
  });
}

export async function deregisterOwnerPushToken(
  deviceId: string,
): Promise<{ ok: boolean }> {
  return request('/api/restaurant/owner/push-token', {
    method: 'DELETE',
    body: { device_id: deviceId },
  });
}
