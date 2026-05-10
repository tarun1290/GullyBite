// StaffContext — single source of truth for the authenticated staff
// member's identity + permissions across the app. Wraps the bearer
// token (in expo-secure-store under 'gb_staff_token') and the hydrate
// call to GET /api/staff/auth/me, exposing both via useStaff()/
// useStaffPermissions() for screen consumers.
//
// Lifecycle:
//   1. On mount the provider reads gb_staff_token from SecureStore. If
//      no token, staff stays null and loading flips to false — the
//      route guard in app/_layout.tsx will redirect to /login.
//   2. With a token, the provider hits getStaffMe() to hydrate the
//      sanitized staff record + permissions. A 401 clears the token
//      (treats it as an expired session) and falls through to the
//      no-token branch.
//   3. After login, the login screen calls refresh() which re-runs
//      step 2 with the freshly-saved token.
//   4. signOut() hits /api/staff/auth/logout best-effort, clears the
//      token regardless of the response, and resets state to null.
//
// This sits alongside the existing AuthProvider in src/store/authStore.tsx
// which still owns multi-branch / role / owner-info state. The two
// providers compose; StaffProvider is the new permission-aware layer
// added by the 2026-05-09 staff-auth refactor.
//
// Part 6b update (2026-05-10): consumers should call useAuth().logout()
// as the canonical session-end entry point. authStore's logout() now
// chains through this provider's signOut() so the staff /me bundle
// clears alongside the legacy auth bundle in a single action. Calling
// useStaff().signOut() directly is still safe but only revokes the
// staff token — it does NOT clear authStore's React state, so screens
// reading useAuth() will still see stale token/role until the next
// route-guard pass.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';

import {
  getStaffMe,
  staffLogout as apiStaffLogout,
  type SanitizedStaff,
  type StaffPermissions,
} from '../api';

const TOKEN_KEY = 'gb_staff_token';

// Default permission map — every key false. Used as the fallback when
// no staff is loaded so consumers can `useStaffPermissions()` without
// null-guards. The permission gates in the order screens treat any
// `false` as "hide button", which is the safe default for an
// unauthenticated render pass.
const EMPTY_PERMISSIONS: StaffPermissions = {
  view_orders: false,
  accept_orders: false,
  reject_orders: false,
  mark_ready: false,
  manage_menu: false,
  manage_stock: false,
  view_reports: false,
  manage_settings: false,
  refund_orders: false,
  view_customer_details: false,
};

interface StaffContextValue {
  staff: SanitizedStaff | null;
  permissions: StaffPermissions;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const StaffContext = createContext<StaffContextValue | null>(null);

export function StaffProvider({ children }: { children: ReactNode }): React.ReactElement {
  const router = useRouter();
  const [staff, setStaff] = useState<SanitizedStaff | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // refresh() runs the bearer-token + /me round-trip. Called from the
  // mount effect (initial hydrate) and from login.tsx after a successful
  // POST /auth so the new staff record + permissions land before we
  // navigate into the app.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const token = await SecureStore.getItemAsync(TOKEN_KEY);
      if (!token) {
        setStaff(null);
        return;
      }
      try {
        const res = await getStaffMe();
        setStaff(res.staff || null);
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 401) {
          // Token rejected — clear so the next hydrate round-trip
          // doesn't keep re-trying with a known-bad credential.
          await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => { /* noop */ });
          setStaff(null);
        } else {
          // Network / 5xx: leave state as-is; screens can decide
          // whether to render against the last-known staff value or
          // surface an inline error. Most callers will retry on a
          // user-driven refresh.
          setStaff(null);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    // Best-effort logout — server-side revocation. Failure (network
    // blip, 401 already, etc.) must NOT block the client clearing its
    // local token; the contract says "Clear local token after success
    // regardless".
    try {
      await apiStaffLogout();
    } catch {
      /* noop */
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => { /* noop */ });
    setStaff(null);
    router.replace('/login');
  }, [router]);

  const permissions: StaffPermissions = useMemo(
    () => staff?.permissions || EMPTY_PERMISSIONS,
    [staff],
  );

  const value: StaffContextValue = useMemo(
    () => ({ staff, permissions, loading, refresh, signOut }),
    [staff, permissions, loading, refresh, signOut],
  );

  return <StaffContext.Provider value={value}>{children}</StaffContext.Provider>;
}

export function useStaff(): StaffContextValue {
  const ctx = useContext(StaffContext);
  if (!ctx) throw new Error('useStaff must be used inside <StaffProvider>');
  return ctx;
}

// Convenience hook — derives the camelCased permission flags from the
// snake_cased StaffPermissions. Screens consume these directly so they
// never need to remember the underlying key names.
export interface StaffPermissionFlags {
  canViewOrders: boolean;
  canAcceptOrders: boolean;
  canRejectOrders: boolean;
  canMarkReady: boolean;
  canManageMenu: boolean;
  canManageStock: boolean;
  canViewReports: boolean;
  canManageSettings: boolean;
  canRefundOrders: boolean;
  canViewCustomerDetails: boolean;
}

export function useStaffPermissions(): StaffPermissionFlags {
  const { permissions } = useStaff();
  return useMemo(
    () => ({
      canViewOrders: !!permissions.view_orders,
      canAcceptOrders: !!permissions.accept_orders,
      canRejectOrders: !!permissions.reject_orders,
      canMarkReady: !!permissions.mark_ready,
      canManageMenu: !!permissions.manage_menu,
      canManageStock: !!permissions.manage_stock,
      canViewReports: !!permissions.view_reports,
      canManageSettings: !!permissions.manage_settings,
      canRefundOrders: !!permissions.refund_orders,
      canViewCustomerDetails: !!permissions.view_customer_details,
    }),
    [permissions],
  );
}
