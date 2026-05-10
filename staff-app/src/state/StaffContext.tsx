// StaffContext — single source of truth for the authenticated session
// across the staff app. Owns:
//   • Bearer token + token-driven /me hydration (sanitized staff record
//     + 10-key permission map sourced from GET /api/staff/auth/me).
//   • Owner identity for the owner-login path (no /me round-trip; the
//     owner record is supplied directly by /api/restaurant/owner/login).
//   • Persisted role (`staff` | `manager` | `owner`) used by the route
//     guard in app/_layout.tsx and the useRole hook.
//   • Multi-branch runtime selection (`currentBranchId`) plus the side-
//     effect plumbing that pushes the selection into the api module's
//     X-Branch-Id header and the SSE dispatcher's branch filter.
//   • Logout — single path that revokes the staff token server-side
//     (best-effort) and clears every persisted credential key.
//
// Part 6c unification (2026-05-10): the legacy `AuthProvider` /
// `useAuth` context (formerly src/store/authStore.tsx) was folded into
// this provider in a single pass — every consumer was migrated to
// `useStaff()` and authStore.tsx was deleted. The dead `branchId`
// (singular) state field — which no consumer ever read — was dropped
// during the merge.
//
// Lifecycle:
//   1. On mount the provider hydrates from SecureStore: token + staff
//      info + restaurant + role + owner info + current-branch.
//   2. If a token is present, refresh() hits GET /api/staff/auth/me to
//      load the sanitized staff record + permissions. A 401 clears the
//      token (treats it as an expired session) and falls through to the
//      no-token branch. Network / 5xx leaves the persisted-side state
//      intact so the operator can keep working off the cached bundle.
//   3. After login, the login screen calls refresh() which re-runs step 2
//      with the freshly-saved token.
//   4. signOut() / logout() hits /api/staff/auth/logout best-effort,
//      clears every credential key, and resets state to null.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'expo-router';

import {
  getStaffMe,
  staffLogout as apiStaffLogout,
  type SanitizedStaff,
  type StaffPermissions,
} from '../api';
import {
  clearAuth,
  getCurrentBranch,
  getOwnerInfo,
  getRestaurant,
  getRole,
  getStaffInfo,
  getToken,
  saveAuth,
  saveCurrentBranch,
  saveOwnerInfo,
  saveRole,
  type CurrentBranchSelection,
  type StoredOwnerInfo,
  type StoredRestaurant,
  type StoredStaffUser,
  type UserRole,
} from '../storage';
import { setBranchHeader } from '../api';
import { setSseBranchFilter } from '../sse';

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

// ─── Auth state (legacy authStore, folded in) ─────────────────────────
//
// The reducer below tracks token + role + persisted staff/owner records
// + the runtime branch selection. `staff` (the SanitizedStaff sourced
// from /me) and `loading` for the /me round-trip live in plain useState
// alongside the reducer so the /me lifecycle stays decoupled from the
// auth-mutation actions.

interface AuthState {
  token: string | null;
  staffUser: StoredStaffUser | null;
  restaurant: StoredRestaurant | null;
  // Multi-branch — `currentBranchId` is the operator's runtime
  // selection (the branch their queries scope to). Defaults to the
  // login branchId (the JWT primary). Can be 'all' for cross-branch
  // views. Hidden from the UI when staffUser.branchIds.length === 1.
  currentBranchId: CurrentBranchSelection | null;
  role: UserRole | null;
  ownerInfo: StoredOwnerInfo | null;
  isLoading: boolean;
}

type AuthAction =
  | { type: 'LOGIN'; token: string; staffUser: StoredStaffUser; restaurant: StoredRestaurant }
  | { type: 'LOGIN_OWNER'; token: string; restaurant: StoredRestaurant; ownerInfo: StoredOwnerInfo }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOADING'; isLoading: boolean }
  | { type: 'SET_CURRENT_BRANCH'; currentBranchId: CurrentBranchSelection }
  | {
      type: 'HYDRATED';
      token: string | null;
      staffUser: StoredStaffUser | null;
      restaurant: StoredRestaurant | null;
      role: UserRole | null;
      ownerInfo: StoredOwnerInfo | null;
      currentBranchId: CurrentBranchSelection | null;
    };

const initialAuthState: AuthState = {
  token: null,
  staffUser: null,
  restaurant: null,
  currentBranchId: null,
  role: null,
  ownerInfo: null,
  isLoading: true,
};

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'LOGIN':
      return {
        token: action.token,
        staffUser: action.staffUser,
        restaurant: action.restaurant,
        // Default the runtime selection to the JWT's primary branchId.
        // The selector dropdown can flip this to 'all' or any other id
        // in branchIds; the value gets persisted via saveCurrentBranch.
        currentBranchId: action.staffUser?.branchId || null,
        // Role comes from the /api/staff/auth response (staffUser.role,
        // populated 2026-05-09). Pre-fix the LOGIN action hardcoded
        // 'staff' which silently demoted managers to staff feature
        // gating. Fallback to 'staff' covers legacy backend that hasn't
        // shipped the response field yet.
        role: action.staffUser?.role || 'staff',
        ownerInfo: null,
        isLoading: false,
      };
    case 'LOGIN_OWNER':
      return {
        token: action.token,
        staffUser: null,
        restaurant: action.restaurant,
        currentBranchId: null,
        role: 'owner',
        ownerInfo: action.ownerInfo,
        isLoading: false,
      };
    case 'LOGOUT':
      return { ...initialAuthState, isLoading: false };
    case 'SET_LOADING':
      return { ...state, isLoading: action.isLoading };
    case 'SET_CURRENT_BRANCH':
      return { ...state, currentBranchId: action.currentBranchId };
    case 'HYDRATED':
      return {
        token: action.token,
        staffUser: action.staffUser,
        restaurant: action.restaurant,
        // Selection precedence on hydrate:
        //   1. persisted gb_current_branch_id (operator's last selection).
        //   2. fall back to the JWT primary branchId.
        currentBranchId: action.currentBranchId || action.staffUser?.branchId || null,
        // Role precedence on hydrate:
        //   1. staffUser.role (post-2026-05-09 logins persist it on the row).
        //   2. separately-stored gb_user_role key (set by saveRole during login).
        //   3. fallback to 'staff' if a staff token exists with neither (very
        //      old install — keeps the session working without forced re-login).
        role: action.staffUser?.role || action.role || (action.staffUser ? 'staff' : null),
        ownerInfo: action.ownerInfo,
        isLoading: false,
      };
    default:
      return state;
  }
}

// ─── Public context shape ─────────────────────────────────────────────

interface StaffContextValue {
  // Auth
  token: string | null;
  role: UserRole | null;
  isLoading: boolean;
  login: (token: string, staffUser: StoredStaffUser, restaurant: StoredRestaurant) => Promise<void>;
  loginAsOwner: (token: string, restaurant: StoredRestaurant, ownerInfo: StoredOwnerInfo) => Promise<void>;
  logout: () => Promise<void>;
  // /me-driven sanitized record + permissions (staff sessions only;
  // owner sessions leave these null / EMPTY).
  staff: SanitizedStaff | null;
  permissions: StaffPermissions;
  // Loading flag for the /me round-trip specifically. Distinct from
  // `isLoading` (the auth hydrate flag) — kept under the legacy name
  // so existing useStaff() callers (login.tsx) keep working.
  loading: boolean;
  refresh: () => Promise<void>;
  // Back-compat alias for callers that expect the old useStaff signOut.
  signOut: () => Promise<void>;
  // Persisted staff identity bundle (login response shape, includes
  // branches[]). Read by BranchSelector and OrderCard. Distinct from
  // the SanitizedStaff above which is sourced from /me.
  staffUser: StoredStaffUser | null;
  restaurant: StoredRestaurant | null;
  ownerInfo: StoredOwnerInfo | null;
  // Multi-branch
  branchIds: string[];
  currentBranchId: CurrentBranchSelection | null;
  // Update the runtime branch selection. Persists to SecureStore so it
  // survives app restarts and pushes the value into the api module so
  // every subsequent request carries the new X-Branch-Id header.
  setCurrentBranchId: (value: CurrentBranchSelection) => Promise<void>;
}

const StaffContext = createContext<StaffContextValue | null>(null);

export function StaffProvider({ children }: { children: ReactNode }): React.ReactElement {
  const router = useRouter();
  const [authState, dispatch] = useReducer(authReducer, initialAuthState);
  const [staff, setStaff] = useState<SanitizedStaff | null>(null);
  const [meLoading, setMeLoading] = useState<boolean>(true);

  // refresh() runs the bearer-token + /me round-trip. Called from the
  // mount effect (initial hydrate) and from login.tsx after a successful
  // POST /auth so the new staff record + permissions land before we
  // navigate into the app.
  const refresh = useCallback(async () => {
    setMeLoading(true);
    try {
      const token = await getToken();
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
          // Token rejected — clear everything so the next hydrate
          // round-trip doesn't keep re-trying with a known-bad
          // credential. Mirrors the legacy authStore behaviour but
          // routes through clearAuth + the LOGOUT action so the auth
          // state machine + SecureStore stay in sync.
          await clearAuth();
          dispatch({ type: 'LOGOUT' });
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
      setMeLoading(false);
    }
  }, []);

  // Initial hydrate — pulls every persisted credential key in parallel
  // then runs /me if a token exists. Owner sessions skip the /me call
  // (no staff record to fetch) so refresh() short-circuits via the
  // staffUser-null branch and meLoading flips to false immediately.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [token, staffInfo, rest, role, owner, currentBranch] = await Promise.all([
        getToken(),
        getStaffInfo(),
        getRestaurant(),
        getRole(),
        getOwnerInfo(),
        getCurrentBranch(),
      ]);
      if (cancelled) return;
      dispatch({
        type: 'HYDRATED',
        token,
        staffUser: staffInfo,
        restaurant: rest,
        role,
        ownerInfo: owner,
        currentBranchId: currentBranch,
      });
      // Owner sessions: no /me to run; staff stays null.
      if (token && role !== 'owner') {
        await refresh();
      } else {
        setMeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  // Push the current branch into the api module + SSE dispatcher on
  // every change so REST requests get the right X-Branch-Id header AND
  // the live order stream filters out other branches' events. Both
  // setters are no-arg-list pure-write functions; their internal slots
  // stay in sync with this React state. Re-runs on hydrate, login, and
  // explicit setCurrentBranchId calls.
  useEffect(() => {
    setBranchHeader(authState.currentBranchId);
    setSseBranchFilter(authState.currentBranchId);
  }, [authState.currentBranchId]);

  const login = useCallback(
    async (token: string, staffUser: StoredStaffUser, restaurant: StoredRestaurant) => {
      await saveAuth(token, restaurant, staffUser);
      // Persist the actual role so route guards + useRole resolve
      // correctly across cold starts. staffUser.role is 'staff' or
      // 'manager' from /api/staff/auth; default to 'staff' if a legacy
      // backend skips the field.
      await saveRole(staffUser.role || 'staff');
      dispatch({ type: 'LOGIN', token, staffUser, restaurant });
    },
    [],
  );

  const loginAsOwner = useCallback(
    async (token: string, restaurant: StoredRestaurant, ownerInfo: StoredOwnerInfo) => {
      // Owner sessions don't carry a staffUser — pass undefined so saveAuth
      // doesn't write stale staff state into SecureStore for an owner login.
      await saveAuth(token, restaurant);
      await saveRole('owner');
      await saveOwnerInfo(ownerInfo);
      dispatch({ type: 'LOGIN_OWNER', token, restaurant, ownerInfo });
    },
    [],
  );

  const logout = useCallback(async () => {
    // Single logout path (Part 6c unification):
    //   1. Best-effort server-side revocation via POST /api/staff/auth/logout.
    //      Failures (network blip, already-401) are swallowed — they
    //      must NOT block the local session-end.
    //   2. clearAuth() — drops every persisted credential key (token,
    //      restaurant, staff_info, role, owner_info, current_branch).
    //   3. dispatch LOGOUT — resets the auth reducer so route guards
    //      see token=null on the next render.
    //   4. setStaff(null) — clears the /me-sourced sanitized record so
    //      permission-gated UI snaps back to the empty default.
    try {
      await apiStaffLogout();
    } catch {
      /* noop */
    }
    await clearAuth();
    dispatch({ type: 'LOGOUT' });
    setStaff(null);
    router.replace('/login');
  }, [router]);

  const setCurrentBranchId = useCallback(async (value: CurrentBranchSelection) => {
    await saveCurrentBranch(value);
    dispatch({ type: 'SET_CURRENT_BRANCH', currentBranchId: value });
  }, []);

  const permissions: StaffPermissions = useMemo(
    () => staff?.permissions || EMPTY_PERMISSIONS,
    [staff],
  );

  const branchIds: string[] = useMemo(
    () => authState.staffUser?.branchIds || [],
    [authState.staffUser],
  );

  const value: StaffContextValue = useMemo(
    () => ({
      // Auth
      token: authState.token,
      role: authState.role,
      isLoading: authState.isLoading,
      login,
      loginAsOwner,
      logout,
      // Staff /me bundle
      staff,
      permissions,
      loading: meLoading,
      refresh,
      signOut: logout,
      // Persisted identity
      staffUser: authState.staffUser,
      restaurant: authState.restaurant,
      ownerInfo: authState.ownerInfo,
      // Multi-branch
      branchIds,
      currentBranchId: authState.currentBranchId,
      setCurrentBranchId,
    }),
    [
      authState.token,
      authState.role,
      authState.isLoading,
      authState.staffUser,
      authState.restaurant,
      authState.ownerInfo,
      authState.currentBranchId,
      staff,
      permissions,
      meLoading,
      branchIds,
      login,
      loginAsOwner,
      logout,
      refresh,
      setCurrentBranchId,
    ],
  );

  return <StaffContext.Provider value={value}>{children}</StaffContext.Provider>;
}

export function useStaff(): StaffContextValue {
  const ctx = useContext(StaffContext);
  if (!ctx) throw new Error('useStaff must be used inside <StaffProvider>');
  return ctx;
}

// Convenience hook — true iff hydrate has completed AND a token is set.
export function useIsAuthenticated(): boolean {
  const { token, isLoading } = useStaff();
  return !isLoading && !!token;
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

// Inline single-key permission check (Part 6d Track B). Suits inline
// ternaries and short-circuit conditionals where pulling in the full
// camelCase flag set is overkill. Mirrors the role bypass in
// <RequirePermission/> and <MaskedField/> so the three primitives
// agree on owner / manager handling.
//
// Usage:
//   const canSeePhone = useHasPermission('view_customer_details');
//   {canSeePhone ? <PhoneText/> : <MaskedFallback/>}
export function useHasPermission(key: keyof StaffPermissions): boolean {
  const { role, permissions } = useStaff();
  // Owner + manager bypass — every key resolves to true.
  if (role === 'owner' || role === 'manager') return true;
  return !!permissions[key];
}
