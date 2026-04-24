// Module-level holders for the logout functions set by each auth context.
// Keeps apiClient's 401 interceptor decoupled from React.
//
// Two separate slots — one per session scope — so a 401 on a restaurant
// API call only logs out the restaurant session (and vice versa). Without
// the split, a 401 from the admin dashboard would log out the restaurant
// owner who's also signed in in another tab, and vice versa.

type LogoutFn = () => void;
type Scope = 'restaurant' | 'admin';

let _restaurantLogoutFn: LogoutFn | null = null;
let _adminLogoutFn: LogoutFn | null = null;

export function setLogoutFn(fn: LogoutFn): void {
  _restaurantLogoutFn = fn;
}

export function setAdminLogoutFn(fn: LogoutFn): void {
  _adminLogoutFn = fn;
}

export function triggerLogout(scope: Scope = 'restaurant'): void {
  const fn = scope === 'admin' ? _adminLogoutFn : _restaurantLogoutFn;
  if (typeof fn === 'function') {
    fn();
    return;
  }
  // Fallback when no context registered yet (rare — mostly during SSR or
  // very early page load). Clear localStorage for the scope and bounce
  // to the right login page.
  if (typeof window !== 'undefined') {
    if (scope === 'admin') {
      window.localStorage.removeItem('gb_admin_token');
      window.localStorage.removeItem('gb_admin_user');
      window.location.replace('/admin/login');
    } else {
      window.localStorage.removeItem('zm_token');
      window.localStorage.removeItem('zm_user');
      window.location.replace('/');
    }
  }
}
