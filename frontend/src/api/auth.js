import authClient from './authClient.js';

export async function getMe() {
  const { data } = await authClient.get('/auth/me');
  return data;
}

export async function pinLogin(pin) {
  const { data } = await authClient.post('/auth/pin-login', pin);
  return data;
}

export async function emailSignin(email, password) {
  const { data } = await authClient.post('/auth/signin', { email, password });
  return data;
}

export async function emailSignup({ ownerName, email, password }) {
  const { data } = await authClient.post('/auth/signup', { ownerName, email, password });
  return data;
}

export async function googleAuth(code) {
  const { data } = await authClient.post('/auth/google', { code });
  return data;
}

export async function changePassword(payload) {
  const { data } = await authClient.post('/auth/change-password', payload);
  return data;
}

export async function deleteAccount() {
  const { data } = await authClient.delete('/auth/delete-account');
  return data;
}

export async function startMetaOAuth(token, payload = {}) {
  const { data } = await authClient.post('/auth/meta/start', payload, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

export async function pollMetaResult(resultId) {
  const { data } = await authClient.get('/auth/meta/result', {
    params: { id: resultId },
  });
  return data;
}
