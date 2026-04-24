'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { getMe } from '../api/auth';
import { setLogoutFn } from '../lib/authStore';
import type { AuthUser } from '../types';

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isRestaurant: boolean;
  login: (token: string | null, user: AuthUser | null) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('zm_token');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const login = useCallback((nextToken: string | null, nextUser: AuthUser | null) => {
    if (typeof window !== 'undefined') {
      if (nextToken) window.localStorage.setItem('zm_token', nextToken);
      if (nextUser) window.localStorage.setItem('zm_user', JSON.stringify(nextUser));
    }
    setToken(nextToken || null);
    setUser(nextUser || null);
  }, []);

  const logout = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('zm_token');
      window.localStorage.removeItem('zm_user');
    }
    setToken(null);
    setUser(null);
    if (typeof window !== 'undefined') {
      window.location.replace('/');
    }
  }, []);

  useEffect(() => {
    setLogoutFn(logout);
  }, [logout]);

  useEffect(() => {
    let cancelled = false;
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('zm_token') : null;
    if (!stored) {
      setLoading(false);
      return () => {};
    }
    getMe()
      .then((me) => {
        if (cancelled) return;
        setUser(me || null);
        if (me && typeof window !== 'undefined') {
          window.localStorage.setItem('zm_user', JSON.stringify(me));
        }
      })
      .catch(() => {
        // 401 already handled by axios interceptor (calls logout via authStore).
        // Other errors: leave user null but clear loading so UI can render.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isAdmin = user?.role === 'admin';
  const isRestaurant = user?.role === 'restaurant';

  const value: AuthContextValue = {
    user,
    token,
    loading,
    isAuthenticated: Boolean(token),
    isAdmin,
    isRestaurant,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export default AuthContext;
