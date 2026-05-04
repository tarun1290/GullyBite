// Auth state context — wraps the SecureStore credential persistence in
// React state so screens can subscribe via useAuth() instead of reading
// SecureStore on every render. Hydrates on mount; the route guard in
// app/_layout.tsx remains the source of truth for "where to send the
// user" (login vs orders vs owner dashboard).

import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import {
  clearAuth,
  getOwnerInfo,
  getRestaurant,
  getRole,
  getStaffInfo,
  getToken,
  saveAuth,
  saveOwnerInfo,
  saveRole,
  type StoredOwnerInfo,
  type StoredRestaurant,
  type StoredStaffUser,
  type UserRole,
} from '../storage';

interface AuthState {
  token: string | null;
  staffUser: StoredStaffUser | null;
  restaurant: StoredRestaurant | null;
  branchId: string | null;
  role: UserRole | null;
  ownerInfo: StoredOwnerInfo | null;
  isLoading: boolean;
}

type Action =
  | { type: 'LOGIN'; token: string; staffUser: StoredStaffUser; restaurant: StoredRestaurant }
  | { type: 'LOGIN_OWNER'; token: string; restaurant: StoredRestaurant; ownerInfo: StoredOwnerInfo }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOADING'; isLoading: boolean }
  | {
      type: 'HYDRATED';
      token: string | null;
      staffUser: StoredStaffUser | null;
      restaurant: StoredRestaurant | null;
      role: UserRole | null;
      ownerInfo: StoredOwnerInfo | null;
    };

const initialState: AuthState = {
  token: null,
  staffUser: null,
  restaurant: null,
  branchId: null,
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
        role: 'staff',
        ownerInfo: null,
        isLoading: false,
      };
    case 'LOGIN_OWNER':
      return {
        token: action.token,
        staffUser: null,
        restaurant: action.restaurant,
        branchId: null,
        role: 'owner',
        ownerInfo: action.ownerInfo,
        isLoading: false,
      };
    case 'LOGOUT':
      return { ...initialState, isLoading: false };
    case 'SET_LOADING':
      return { ...state, isLoading: action.isLoading };
    case 'HYDRATED':
      return {
        token: action.token,
        staffUser: action.staffUser,
        restaurant: action.restaurant,
        branchId: action.staffUser?.branchId || null,
        // Back-compat: pre-2.x installs have no role stored. If we see a
        // staff token + no role we treat it as 'staff' so the existing
        // session keeps working without forcing a re-login.
        role: action.role || (action.staffUser ? 'staff' : null),
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
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [token, staff, rest, role, owner] = await Promise.all([
        getToken(),
        getStaffInfo(),
        getRestaurant(),
        getRole(),
        getOwnerInfo(),
      ]);
      if (cancelled) return;
      dispatch({ type: 'HYDRATED', token, staffUser: staff, restaurant: rest, role, ownerInfo: owner });
    })();
    return () => { cancelled = true; };
  }, []);

  const value: AuthContextValue = {
    ...state,
    async login(token, staffUser, restaurant) {
      await saveAuth(token, restaurant, staffUser);
      await saveRole('staff');
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
      await clearAuth();
      dispatch({ type: 'LOGOUT' });
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
