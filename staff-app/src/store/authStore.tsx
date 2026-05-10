// Auth state context — wraps the SecureStore credential persistence in
// React state so screens can subscribe via useAuth() instead of reading
// SecureStore on every render. Hydrates on mount; the route guard in
// app/_layout.tsx remains the source of truth for "where to send the
// user" (login vs orders vs owner dashboard).
//
// Part 6b note (2026-05-10): authStore (this file) and StaffContext
// (../state/StaffContext.tsx) coexist by design. authStore owns
// multi-branch selection, owner-side identity, role-routing, and SSE
// branch-filter wiring — none of which the staff /me endpoint covers.
// StaffContext owns the sanitized staff record + permission map driven
// off /api/staff/auth/me. Consolidating both surfaces into a single
// context would have meant re-implementing the multi-branch selector
// pipeline + owner login flow inside StaffContext, well outside the
// scope of this cleanup. Instead, logout() below now chains through to
// the staff token / staff-side server revocation so a single logout
// clears BOTH credential bundles. Consumers should still call
// useAuth().logout() — that is the canonical session-end entry point.

import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
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
import { useStaff } from '../state/StaffContext';

interface AuthState {
  token: string | null;
  staffUser: StoredStaffUser | null;
  restaurant: StoredRestaurant | null;
  branchId: string | null;
  // Multi-branch — `currentBranchId` is the operator's runtime
  // selection (the branch their queries scope to). Defaults to the
  // login `branchId` (the JWT primary). Can be 'all' for cross-branch
  // views. Hidden from the UI when staffUser.branchIds.length === 1.
  currentBranchId: CurrentBranchSelection | null;
  role: UserRole | null;
  ownerInfo: StoredOwnerInfo | null;
  isLoading: boolean;
}

type Action =
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

const initialState: AuthState = {
  token: null,
  staffUser: null,
  restaurant: null,
  branchId: null,
  currentBranchId: null,
  role: null,
  ownerInfo: null,
  isLoading: true,
};

function reducer(state: AuthState, action: Action): AuthState {
  switch (action.type) {
    case 'LOGIN':
      return {
        token: action.token,
        staffUser: action.staffUser,
        restaurant: action.restaurant,
        branchId: action.staffUser?.branchId || null,
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
        branchId: null,
        currentBranchId: null,
        role: 'owner',
        ownerInfo: action.ownerInfo,
        isLoading: false,
      };
    case 'LOGOUT':
      return { ...initialState, isLoading: false };
    case 'SET_LOADING':
      return { ...state, isLoading: action.isLoading };
    case 'SET_CURRENT_BRANCH':
      return { ...state, currentBranchId: action.currentBranchId };
    case 'HYDRATED':
      return {
        token: action.token,
        staffUser: action.staffUser,
        restaurant: action.restaurant,
        branchId: action.staffUser?.branchId || null,
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

interface AuthContextValue extends AuthState {
  login: (token: string, staffUser: StoredStaffUser, restaurant: StoredRestaurant) => Promise<void>;
  loginAsOwner: (token: string, restaurant: StoredRestaurant, ownerInfo: StoredOwnerInfo) => Promise<void>;
  logout: () => Promise<void>;
  // Update the runtime branch selection. Persists to SecureStore so it
  // survives app restarts and pushes the value into the api module so
  // every subsequent request carries the new X-Branch-Id header.
  setCurrentBranchId: (value: CurrentBranchSelection) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState);
  // StaffProvider sits above AuthProvider in the tree (see
  // app/_layout.tsx) so this hook resolves at render time. logout()
  // chains through staffSignOut() so the staff /me bundle (token,
  // sanitized record, permissions) clears alongside the legacy auth
  // bundle in a single user-driven action.
  const { signOut: staffSignOut } = useStaff();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [token, staff, rest, role, owner, currentBranch] = await Promise.all([
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
        token, staffUser: staff, restaurant: rest, role, ownerInfo: owner,
        currentBranchId: currentBranch,
      });
    })();
    return () => { cancelled = true; };
  }, []);

  // Push the current branch into the api module + SSE dispatcher on
  // every change so REST requests get the right X-Branch-Id header AND
  // the live order stream filters out other branches' events. Both
  // setters are no-arg-list pure-write functions; their internal slots
  // stay in sync with this React state. Re-runs on hydrate, login, and
  // explicit setCurrentBranchId calls.
  useEffect(() => {
    setBranchHeader(state.currentBranchId);
    setSseBranchFilter(state.currentBranchId);
  }, [state.currentBranchId]);

  const value: AuthContextValue = {
    ...state,
    async login(token, staffUser, restaurant) {
      await saveAuth(token, restaurant, staffUser);
      // Persist the actual role so route guards + useRole resolve
      // correctly across cold starts. staffUser.role is 'staff' or
      // 'manager' from /api/staff/auth; default to 'staff' if a legacy
      // backend skips the field.
      await saveRole(staffUser.role || 'staff');
      dispatch({ type: 'LOGIN', token, staffUser, restaurant });
    },
    async loginAsOwner(token, restaurant, ownerInfo) {
      // Owner sessions don't carry a staffUser — pass undefined so saveAuth
      // doesn't write stale staff state into SecureStore for an owner login.
      await saveAuth(token, restaurant);
      await saveRole('owner');
      await saveOwnerInfo(ownerInfo);
      dispatch({ type: 'LOGIN_OWNER', token, restaurant, ownerInfo });
    },
    async logout() {
      // Chain through both credential bundles so a single user-driven
      // logout fully ends the session (Part 6b consolidation):
      //   1. staffSignOut() — best-effort server-side revocation
      //      (POST /api/staff/auth/logout), drops gb_staff_token from
      //      SecureStore, resets StaffContext's React state to null,
      //      and navigates to /login. Failures inside StaffContext are
      //      already swallowed so a flaky network can't pin a user
      //      inside the app. No-op for owner sessions where the key
      //      was never written.
      //   2. clearAuth() — drops the legacy auth bundle (token,
      //      restaurant, staffInfo, role, ownerInfo, currentBranch)
      //      from SecureStore.
      //   3. dispatch LOGOUT — resets this provider's React state so
      //      route guards see token=null on the next render.
      try { await staffSignOut(); } catch { /* noop */ }
      await clearAuth();
      dispatch({ type: 'LOGOUT' });
    },
    async setCurrentBranchId(value) {
      await saveCurrentBranch(value);
      dispatch({ type: 'SET_CURRENT_BRANCH', currentBranchId: value });
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function useIsAuthenticated(): boolean {
  const { token, isLoading } = useAuth();
  return !isLoading && !!token;
}
