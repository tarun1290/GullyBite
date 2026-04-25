import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { triggerLogout } from './authStore';

declare module 'axios' {
  interface AxiosError {
    userMessage?: string | null;
  }
}

const baseURL = process.env.NEXT_PUBLIC_API_BASE_URL || '';

console.log('🌐 CLIENT ENV:', process.env.NEXT_PUBLIC_API_BASE_URL);

const client: AxiosInstance = axios.create({
  baseURL,
  timeout: 20000,
});

// Two-scope auth: admin requests carry the admin token + log the admin
// session out on 401; everything else carries the restaurant token. Scope
// is determined by URL prefix so call sites don't need any per-request
// configuration. The two sessions can coexist in the same browser tab.
function isAdminRequest(config: InternalAxiosRequestConfig): boolean {
  const url = config.url || '';
  // Match both '/api/admin/...' and '/admin/...' (some helpers omit /api).
  return url.startsWith('/api/admin/') || url.startsWith('/admin/');
}

client.interceptors.request.use((config) => {
  if (typeof window === 'undefined') return config;
  const tokenKey = isAdminRequest(config) ? 'gb_admin_token' : 'zm_token';
  const token = window.localStorage.getItem(tokenKey);
  if (!token) return config;
  const headers = config.headers;
  const hasAuth = Boolean(
    headers &&
      ((headers as Record<string, unknown>)['Authorization'] ||
        (headers as Record<string, unknown>)['authorization']),
  );
  if (!hasAuth) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const data = error.response?.data;
    if (data && typeof data === 'object') {
      const d = data as { error?: string; message?: string };
      error.userMessage = d.error || d.message || null;
    } else {
      error.userMessage = null;
    }
    if (error.response?.status === 401) {
      // Dispatch logout to the right scope so a 401 on an admin call
      // doesn't kill the restaurant owner's parallel session (or vice versa).
      const scope = error.config && isAdminRequest(error.config) ? 'admin' : 'restaurant';
      triggerLogout(scope);
    }
    return Promise.reject(error);
  },
);

export default client;
