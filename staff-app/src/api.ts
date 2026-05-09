// Thin fetch wrapper: reads base URL from app.config extra, attaches the
// staff JWT, surfaces HTTP errors as thrown Error(msg) with the server's
// `error` field when available.

import Constants from 'expo-constants';
import { getToken, type CurrentBranchSelection } from './storage';

const BASE =
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ||
  process.env.EXPO_PUBLIC_API_URL ||
  'https://gullybite.duckdns.org';

export function apiBase(): string {
  return BASE.replace(/\/+$/, '');
}

// Module-level branch header — pushed in by AuthProvider on every
// currentBranchId change so call sites don't have to thread the value
// through. Null = no header (back-compat path; backend defaults to JWT
// primary). Set via setBranchHeader, read on each request.
let _currentBranchHeader: CurrentBranchSelection | null = null;

export function setBranchHeader(value: CurrentBranchSelection | null): void {
  _currentBranchHeader = value;
}

type FetchOpts = {
  method?: string;
  body?: unknown;
  auth?: boolean; // default true
  headers?: Record<string, string>;
  // Per-request opt-out for endpoints that must NOT carry X-Branch-Id
  // (e.g. /api/staff/auth itself — branch context doesn't exist yet).
  // Defaults to true (header attached) for authed requests.
  branchScoped?: boolean;
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
    // Attach X-Branch-Id automatically on authed requests. Only when a
    // value is set (post-login or post-hydrate) and the caller didn't
    // explicitly opt out. Header was NOT in the request before
    // 2026-05-09 — backend's resolveBranchScope falls back to the JWT
    // primary when missing, so leaving it off is the safe default.
    if (opts.branchScoped !== false && _currentBranchHeader) {
      headers['X-Branch-Id'] = String(_currentBranchHeader);
    }
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
    // Backend writes 'staff' or 'manager' (per the role-filter at
    // routes/staff.js POST /auth). Optional for back-compat with a
    // pre-2026-05-09 backend that hadn't shipped the field yet.
    role?: 'staff' | 'manager';
    // Multi-branch additions. branch_ids is the full assigned access
    // set (used to validate X-Branch-Id values and to render the
    // selector); branches[] carries {id, name} pairs sourced from the
    // branches collection in the same /auth round-trip.
    branch_ids?: string[];
    branches?: Array<{ id: string; name: string }>;
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
  // Detail-only breakdown — populated by GET /api/staff/orders/:orderId,
  // not by the list endpoint. Optional so list-shaped values still
  // satisfy the type.
  subtotal_rs?: number | null;
  delivery_fee_rs?: number | null;
  discount_rs?: number | null;
  status?: string;
  payment_status?: string | null;
  branch_id?: string | null;
  accepted_at?: string | null;
  delivered_at?: string | null;
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
//
// FUTURE FEATURE: legacy staff-link login. The new flow is
// staffLogin(store_slug, staff_id, pin) below — this old helper is
// retained only so transitional callers (if any) keep type-checking
// while the refactor lands. Will be removed in a follow-up once we
// confirm no callers remain.
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

// ─── New staff-auth flow (2026-05-09) ────────────────────────────────
//
// Backend contract (POST /api/staff/auth):
//   Body:    { store_slug, staff_id, pin }
//   200:     { ok: true, token, staff: SanitizedStaff }
//   401:     { ok: false, error: 'invalid_credentials' }
//   429:     { ok: false, error: 'rate_limited' }
//   400:     { ok: false, error: 'deprecated_login_payload' }
//
// SanitizedStaff carries the 10 permission keys the UI gates against
// — see useStaffPermissions in src/state/StaffContext.tsx.

export type StaffPermissions = {
  view_orders: boolean;
  accept_orders: boolean;
  reject_orders: boolean;
  mark_ready: boolean;
  manage_menu: boolean;
  manage_stock: boolean;
  view_reports: boolean;
  manage_settings: boolean;
  refund_orders: boolean;
  view_customer_details: boolean;
};

export type SanitizedStaff = {
  _id: string;
  restaurant_id: string;
  staff_id: string;
  name: string;
  display_name: string;
  phone?: string;
  role: string;
  role_preset: string;
  branch_ids: string[];
  branchIds: string[];
  permissions: StaffPermissions;
  is_active: boolean;
  active: boolean;
  created_at: string;
  last_active_at?: string;
};

export type StaffLoginV2Response = {
  ok: true;
  token: string;
  staff: SanitizedStaff;
};

export type StaffMeResponse = {
  ok: true;
  staff: SanitizedStaff;
  permissions: StaffPermissions;
};

export async function staffLogin(input: {
  store_slug: string;
  staff_id: string;
  pin: string;
}): Promise<StaffLoginV2Response> {
  return request<StaffLoginV2Response>('/api/staff/auth', {
    method: 'POST',
    body: {
      store_slug: input.store_slug,
      staff_id: input.staff_id,
      pin: input.pin,
    },
    auth: false,
    // Pre-login: no branch context exists yet.
    branchScoped: false,
  });
}

export async function getStaffMe(): Promise<StaffMeResponse> {
  return request<StaffMeResponse>('/api/staff/auth/me', {
    method: 'GET',
    branchScoped: false,
  });
}

export async function staffLogout(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/staff/auth/logout', {
    method: 'POST',
    branchScoped: false,
  });
}

// Public lookup — no JWT. Resolves the per-branch staff_access_token
// to display context so the login screen can show the operator
// "{restaurant_name} — {branch_name}" before they type their PIN.
// Backend route: backend/src/routes/staff.js GET /branch-info.
export type BranchInfo = {
  branch_name: string | null;
  restaurant_name: string | null;
};

export async function getBranchInfo(
  staffAccessToken: string,
): Promise<BranchInfo> {
  // Embed the token into the path manually so the existing `request`
  // helper (which doesn't take a `params` option) doesn't need a new
  // shape. encodeURIComponent guards against any URL-special chars
  // that might land in a future token format.
  return request<BranchInfo>(
    `/api/staff/branch-info?token=${encodeURIComponent(staffAccessToken)}`,
    { auth: false },
  );
}

// `date` is an optional YYYY-MM-DD IST calendar day. When omitted, the
// backend returns the live (non-terminal) set; when present, it returns
// every order created on that day regardless of status.
export async function getOrders(opts?: { date?: string }): Promise<{ orders: StaffOrder[] }> {
  const qs = opts?.date ? `?date=${encodeURIComponent(opts.date)}` : '';
  return request<{ orders: StaffOrder[] }>(`/api/staff/orders${qs}`);
}

// Single-order detail. Status-agnostic — works for past orders and
// orders past PACKED that the live list endpoint no longer returns.
export async function getOrder(orderId: string): Promise<{ order: StaffOrder }> {
  return request<{ order: StaffOrder }>(`/api/staff/orders/${encodeURIComponent(orderId)}`);
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
