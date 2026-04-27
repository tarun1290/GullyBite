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
import type { StaffAuthResult, StaffOrder } from '../types';

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
