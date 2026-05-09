// Web-staff API helpers (consumed by /staff/[staffAccessToken]/* pages).
//
// All requests go through staffApiClient — which carries the
// 'staff_web_token' JWT, separate from the owner / admin scopes.
//
// /accept and /decline live under /api/restaurant/orders/* but accept
// either an owner token OR a staff token (combined middleware in
// backend/src/middleware/staffAuth.requireStaffOrRestaurantAuth).
// Staff status updates use /api/staff/orders/:id/status which is staff
// only and lowercase-statused.

import staffClient from '../lib/staffApiClient';
import client from '../lib/apiClient';
import type {
  Permissions,
  RolePreset,
  Staff,
  StaffAuthResult,
  StaffOrder,
} from '../types';

// Public branch-info lookup — no JWT required. The login page calls
// this on mount to display "{restaurant_name} — {branch_name}" before
// the operator types their PIN. staffClient's request interceptor
// skips the Authorization header when no token is in localStorage, so
// this call goes out unauthenticated as expected.
export interface StaffBranchInfo {
  branch_name: string | null;
  restaurant_name: string | null;
}

export async function getStaffBranchInfo(
  staffAccessToken: string,
): Promise<StaffBranchInfo> {
  const { data } = await staffClient.get<StaffBranchInfo>('/api/staff/branch-info', {
    params: { token: staffAccessToken },
  });
  return data;
}

export async function staffWebLogin(
  staffAccessToken: string,
  name: string,
  pin: string,
): Promise<StaffAuthResult> {
  const { data } = await staffClient.post<StaffAuthResult>('/api/staff/auth', {
    staff_access_token: staffAccessToken,
    name,
    pin,
  });
  return data;
}

interface StaffOrdersResponse {
  success: true;
  orders: StaffOrder[];
}

export async function getStaffOrders(): Promise<StaffOrder[]> {
  const { data } = await staffClient.get<StaffOrdersResponse>('/api/staff/orders');
  return Array.isArray(data?.orders) ? data.orders : [];
}

// PAID → CONFIRMED. Combined middleware accepts the staff token here.
export async function staffAcceptOrder(orderId: string): Promise<unknown> {
  const { data } = await staffClient.post(
    `/api/restaurant/orders/${encodeURIComponent(orderId)}/accept`,
  );
  return data;
}

// PAID → REJECTED_BY_RESTAURANT. Reason is required by the route's
// validation (combined middleware).
export async function staffDeclineOrder(
  orderId: string,
  reason: string,
): Promise<unknown> {
  const { data } = await staffClient.post(
    `/api/restaurant/orders/${encodeURIComponent(orderId)}/decline`,
    { reason },
  );
  return data;
}

// CONFIRMED → PREPARING and PREPARING → PACKED. The staff route maps
// lowercase keys to canonical uppercase enum values.
export type StaffStatusKey = 'preparing' | 'ready' | 'packed';

export async function staffUpdateOrderStatus(
  orderId: string,
  status: StaffStatusKey,
): Promise<unknown> {
  const { data } = await staffClient.patch(
    `/api/staff/orders/${encodeURIComponent(orderId)}/status`,
    { status },
  );
  return data;
}

// ── Owner staff management (zm_token) ──────────────────────────────
// These hit /api/restaurant/staff* and use the OWNER apiClient (so they
// carry zm_token, not staff_web_token). Returned shapes are typed
// off the SanitizedStaff contract documented in types/index.ts.

interface ListStaffResponse {
  ok: true;
  staff: Staff[];
}

export async function listStaff(): Promise<Staff[]> {
  const { data } = await client.get<ListStaffResponse>('/api/restaurant/staff');
  return Array.isArray(data?.staff) ? data.staff : [];
}

// Owner-side create payload. PIN is auto-generated server-side and
// returned ONCE in `generated_pin` — the modal must surface it
// immediately because no later API call will return it.
export interface CreateStaffPayload {
  display_name: string;
  phone?: string;
  role_preset: RolePreset;
  branch_ids: string[];
  permissions: Permissions;
}

export interface CreateStaffResponse {
  ok: true;
  staff: Staff;
  generated_pin: string;
}

export async function createStaff(
  payload: CreateStaffPayload,
): Promise<CreateStaffResponse> {
  const { data } = await client.post<CreateStaffResponse>(
    '/api/restaurant/staff',
    payload,
  );
  return data;
}

// Update payload shape. All fields optional so callers can do partial
// updates (e.g. just toggling is_active). reset_pin: true tells the
// backend to mint a new PIN; the response then carries `generated_pin`
// the same way create does.
export interface UpdateStaffPayload {
  display_name?: string;
  phone?: string;
  role_preset?: RolePreset;
  branch_ids?: string[];
  permissions?: Permissions;
  is_active?: boolean;
  reset_pin?: boolean;
}

export interface UpdateStaffResponse {
  ok: true;
  staff: Staff;
  generated_pin?: string;
}

export async function updateStaff(
  id: string,
  payload: UpdateStaffPayload,
): Promise<UpdateStaffResponse> {
  const { data } = await client.put<UpdateStaffResponse>(
    `/api/restaurant/staff/${encodeURIComponent(id)}`,
    payload,
  );
  return data;
}

interface DeactivateStaffResponse {
  ok: true;
}

export async function deactivateStaff(id: string): Promise<DeactivateStaffResponse> {
  const { data } = await client.delete<DeactivateStaffResponse>(
    `/api/restaurant/staff/${encodeURIComponent(id)}`,
  );
  return data;
}

// Convenience wrapper around updateStaff with reset_pin: true. The
// response is guaranteed to carry generated_pin in success cases.
export async function resetStaffPin(id: string): Promise<UpdateStaffResponse> {
  return updateStaff(id, { reset_pin: true });
}
