// validateEnv.ts
export function validateEnv() {
  const baseURL = process.env.NEXT_PUBLIC_API_BASE_URL;

  if (!baseURL) {
    throw new Error('Missing API base URL');
  }

  if (!baseURL.startsWith('https://')) {
    throw new Error('API must use HTTPS in production');
  }
}
