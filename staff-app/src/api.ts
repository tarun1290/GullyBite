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

// ─── Types ────────────────────────────────────────────────────────────

export type StaffLoginResponse = {
  token: string;
  restaurant: {
    id: string;
    name?: string;
    slug?: string;
    logo_url?: string | null;
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
  status?: string;
  payment_status?: string | null;
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
  image_url?: string | null;
};

export type StaffMenuResponse = {
  categories: Array<{ name: string; items: StaffMenuItem[] }>;
};

// ─── Endpoints ────────────────────────────────────────────────────────

export async function login(slug: string, pin: string): Promise<StaffLoginResponse> {
  return request<StaffLoginResponse>('/api/staff/auth', {
    method: 'POST',
    body: { slug: slug.trim().toLowerCase(), pin },
    auth: false,
  });
}

export async function getOrders(): Promise<{ orders: StaffOrder[] }> {
  return request<{ orders: StaffOrder[] }>('/api/staff/orders');
}

export async function updateOrderStatus(orderId: string, status: string): Promise<{ success: boolean; status: string }> {
  return request(`/api/staff/orders/${encodeURIComponent(orderId)}/status`, {
    method: 'PATCH',
    body: { status },
  });
}

export async function getMenu(): Promise<StaffMenuResponse> {
  return request<StaffMenuResponse>('/api/staff/menu');
}

export async function updateItemAvailability(
  itemId: string,
  isAvailable: boolean
): Promise<{ success: boolean }> {
  return request(`/api/staff/menu/${encodeURIComponent(itemId)}/availability`, {
    method: 'PATCH',
    body: { is_available: isAvailable },
  });
}

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
