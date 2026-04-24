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
