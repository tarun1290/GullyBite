let _logoutFn = null;

export function setLogoutFn(fn) {
  _logoutFn = fn;
}

export function triggerLogout() {
  if (typeof _logoutFn === 'function') {
    _logoutFn();
    return;
  }
  localStorage.removeItem('zm_token');
  localStorage.removeItem('zm_user');
  if (typeof window !== 'undefined') {
    window.location.replace('/');
  }
}
