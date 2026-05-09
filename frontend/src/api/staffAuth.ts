// Staff-side auth helpers for the patched (Bearer-only) login flow.
//
// Endpoints (final):
//   POST /api/staff/auth         — body { store_slug, staff_id, pin }
//   POST /api/staff/auth/logout  — body {}
//   GET  /api/staff/auth/me      — Bearer required
//
// All requests funnel through staffApiClient so the Authorization
// header / 'staff_web_token' contract stays in one place. We do NOT
// touch localStorage here — the login page persists the token after a
// successful response, and the logout helper hands the cleanup to
// staffApiClient.clearStaffToken so the key name stays canonical.

import staffClient from '../lib/staffApiClient';
import type { Permissions, Staff } from '../types';

// POST /api/staff/auth — body shape mirrors the backend handler in
// backend/src/routes/staff.js. The login form passes all three fields
// as plain strings; the backend handles trimming + case-folding of
// store_slug / staff_id.
export interface StaffLoginRequest {
  store_slug: string;
  staff_id: string;
  pin: string;
}

export interface StaffLoginResponse {
  ok: true;
  token: string;
  staff: Staff;
}

export async function staffLogin(
  payload: StaffLoginRequest,
): Promise<StaffLoginResponse> {
  const { data } = await staffClient.post<StaffLoginResponse>(
    '/api/staff/auth',
    payload,
  );
  return data;
}

// POST /api/staff/auth/logout — best-effort. Backend invalidates the
// session row; the caller should still strip the token locally
// regardless of the response (see clearStaffToken in staffApiClient).
export interface StaffLogoutResponse {
  ok: boolean;
}

export async function staffLogout(): Promise<StaffLogoutResponse> {
  const { data } = await staffClient.post<StaffLogoutResponse>(
    '/api/staff/auth/logout',
    {},
  );
  return data;
}

// GET /api/staff/auth/me — used by the orders page on mount to verify
// the persisted token + read the staff identity / permissions. A 401
// here means the token is expired or revoked; the caller redirects
// to /staff/login.
export interface StaffMeResponse {
  ok: true;
  staff: Staff;
  permissions: Permissions;
}

export async function getStaffMe(): Promise<StaffMeResponse> {
  const { data } = await staffClient.get<StaffMeResponse>('/api/staff/auth/me');
  return data;
}
