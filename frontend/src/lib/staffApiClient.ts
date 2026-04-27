// Web-staff axios client. Kept separate from the owner-scoped client
// in lib/apiClient.ts because:
//
//   1. The token lives under a different localStorage key
//      ('staff_web_token') so a staff session and an owner session can
//      coexist in the same browser without one logging the other out.
//   2. On 401 we do NOT call triggerLogout('restaurant') — that would
//      tear down the owner session if both are open. Instead the page
//      that issued the request handles the 401 itself (silent redirect
//      to the staff login screen).
//
// The token attaches to every request via an interceptor; pages just
// import these helpers and call them.

import axios, { type AxiosError, type AxiosInstance } from 'axios';

export const STAFF_TOKEN_KEY = 'staff_web_token';

const baseURL = process.env.NEXT_PUBLIC_API_BASE_URL || '';

const staffClient: AxiosInstance = axios.create({
  baseURL,
  timeout: 20000,
});

staffClient.interceptors.request.use((config) => {
  if (typeof window === 'undefined') return config;
  const token = window.localStorage.getItem(STAFF_TOKEN_KEY);
  if (!token) return config;
  if (!config.headers.get('Authorization') && !config.headers.get('authorization')) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

// Surface a userMessage on AxiosError so callsites can render the
// backend's `error` string directly without re-extracting.
declare module 'axios' {
  interface AxiosError {
    userMessage?: string | null;
  }
}

staffClient.interceptors.response.use(
  (r) => r,
  (error: AxiosError) => {
    const data = error.response?.data;
    if (data && typeof data === 'object') {
      const d = data as { error?: string; message?: string };
      error.userMessage = d.error || d.message || null;
    } else {
      error.userMessage = null;
    }
    return Promise.reject(error);
  },
);

export default staffClient;

export function clearStaffToken(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(STAFF_TOKEN_KEY); } catch { /* ignore */ }
}

export function setStaffToken(token: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STAFF_TOKEN_KEY, token); } catch { /* ignore */ }
}

export function getStaffToken(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(STAFF_TOKEN_KEY); } catch { return null; }
}
