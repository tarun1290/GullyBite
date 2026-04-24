// Module-level holder for the logout function set by the auth context. Keeps
// apiClient's 401 interceptor decoupled from React. Migrated verbatim from
// frontend/src/contexts/authStore.js.

type LogoutFn = () => void;

let _logoutFn: LogoutFn | null = null;

export function setLogoutFn(fn: LogoutFn): void {
  _logoutFn = fn;
}

export function triggerLogout(): void {
  if (typeof _logoutFn === 'function') {
    _logoutFn();
    return;
  }
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem('zm_token');
    window.localStorage.removeItem('zm_user');
    window.location.replace('/');
  }
}
