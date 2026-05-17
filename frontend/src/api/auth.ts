import client from '../lib/apiClient';
import type { AuthResponse, AuthUser, RequestBody } from '../types';

export async function getMe(): Promise<AuthUser> {
  const { data } = await client.get<AuthUser>('/auth/me');
  return data;
}

export async function pinLogin(pin: RequestBody): Promise<AuthResponse> {
  const { data } = await client.post<AuthResponse>('/auth/pin-login', pin);
  return data;
}

export async function emailSignin(email: string, password: string): Promise<AuthResponse> {
  const { data } = await client.post<AuthResponse>('/auth/signin', { email, password });
  return data;
}

export interface EmailSignupBody {
  ownerName: string;
  email: string;
  password: string;
}

export async function emailSignup(body: EmailSignupBody): Promise<AuthResponse> {
  const { data } = await client.post<AuthResponse>('/auth/signup', body);
  return data;
}

export async function googleAuth(code: string): Promise<AuthResponse> {
  const { data } = await client.post<AuthResponse>('/auth/google', { code });
  return data;
}

export async function manualLogin(email: string, password: string): Promise<AuthResponse> {
  const { data } = await client.post<AuthResponse>('/auth/manual-login', { email, password });
  return data;
}

export async function changePassword(payload: RequestBody): Promise<unknown> {
  const { data } = await client.post('/auth/change-password', payload);
  return data;
}

export async function deleteAccount(): Promise<unknown> {
  const { data } = await client.delete('/auth/delete-account');
  return data;
}

export async function startMetaOAuth(token: string, payload: RequestBody = {}): Promise<unknown> {
  const { data } = await client.post('/auth/meta/start', payload, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

export async function pollMetaResult(resultId: string): Promise<unknown> {
  const { data } = await client.get('/auth/meta/result', { params: { id: resultId } });
  return data;
}

// Platform (System User) token health. WhatsApp messaging for every
// restaurant runs on the single platform token, so this — not any
// per-restaurant token age — is what the dashboard banner reflects.
export interface PlatformTokenHealth {
  status: 'healthy' | 'expired_or_invalid';
  name?: string | null;
  error?: string;
}

export async function getPlatformTokenHealth(): Promise<PlatformTokenHealth> {
  const { data } = await client.get<PlatformTokenHealth>('/auth/platform-token-health');
  return data;
}
