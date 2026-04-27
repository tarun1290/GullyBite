// Auth state context — wraps the SecureStore credential persistence in
// React state so screens can subscribe via useAuth() instead of reading
// SecureStore on every render. Hydrates on mount; the route guard in
// app/_layout.tsx remains the source of truth for "where to send the
// user" (login vs orders).

import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import {
  clearAuth,
  getRestaurant,
  getStaffInfo,
  getToken,
  saveAuth,
  type StoredRestaurant,
  type StoredStaffUser,
} from '../storage';

interface AuthState {
  token: string | null;
  staffUser: StoredStaffUser | null;
  restaurant: StoredRestaurant | null;
  branchId: string | null;
  isLoading: boolean;
}

type Action =
  | { type: 'LOGIN'; token: string; staffUser: StoredStaffUser; restaurant: StoredRestaurant }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOADING'; isLoading: boolean }
  | { type: 'HYDRATED'; token: string | null; staffUser: StoredStaffUser | null; restaurant: StoredRestaurant | null };

const initialState: AuthState = {
  token: null,
  staffUser: null,
  restaurant: null,
  branchId: null,
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
        isLoading: false,
      };
    default:
      return state;
  }
}

interface AuthContextValue extends AuthState {
  login: (token: string, staffUser: StoredStaffUser, restaurant: StoredRestaurant) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [token, staff, rest] = await Promise.all([
        getToken(),
        getStaffInfo(),
        getRestaurant(),
      ]);
      if (cancelled) return;
      dispatch({ type: 'HYDRATED', token, staffUser: staff, restaurant: rest });
    })();
    return () => { cancelled = true; };
  }, []);

  const value: AuthContextValue = {
    ...state,
    async login(token, staffUser, restaurant) {
      await saveAuth(token, restaurant, staffUser);
      dispatch({ type: 'LOGIN', token, staffUser, restaurant });
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
