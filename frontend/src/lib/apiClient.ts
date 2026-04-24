import axios, { type AxiosError, type AxiosInstance } from 'axios';
import { triggerLogout } from './authStore';

declare module 'axios' {
  interface AxiosError {
    userMessage?: string | null;
  }
}

const baseURL = process.env.NEXT_PUBLIC_API_BASE_URL || '';

const client: AxiosInstance = axios.create({
  baseURL,
  timeout: 20000,
});

client.interceptors.request.use((config) => {
  if (typeof window === 'undefined') return config;
  const token = window.localStorage.getItem('zm_token');
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
      triggerLogout();
    }
    return Promise.reject(error);
  },
);

export default client;
