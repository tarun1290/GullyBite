import axios from 'axios';
import { triggerLogout } from '../contexts/authStore.js';

// Auth endpoints live on Vercel, not EC2. The main client.js points at
// VITE_API_BASE_URL (EC2), which only serves webhooks/crons — see
// backend/ec2-server.js. This client targets the Vercel deployment.
const baseURL = import.meta.env.VITE_AUTH_API_BASE_URL || '';

const authClient = axios.create({
  baseURL,
  timeout: 20000,
});

authClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('zm_token');
  config.headers = config.headers || {};
  const hasAuth =
    config.headers.Authorization ||
    config.headers.authorization ||
    (config.headers.common && (config.headers.common.Authorization || config.headers.common.authorization));
  if (token && !hasAuth) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

authClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const data = error.response && error.response.data;
    if (data && typeof data === 'object') {
      error.userMessage = data.error || data.message || null;
    } else {
      error.userMessage = null;
    }
    if (error.response && error.response.status === 401) {
      triggerLogout();
    }
    return Promise.reject(error);
  }
);

export default authClient;
