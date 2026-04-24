'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { getAdminMe } from '../api/admin';
import { setAdminLogoutFn } from '../lib/authStore';
import type { AuthUser } from '../types';

// Separate auth context for the /admin/* surface so logging out one role
// doesn't kill the other's session. Uses gb_admin_token / gb_admin_user
// localStorage keys (the restaurant context uses zm_token / zm_user).
//
// apiClient picks the right token by URL prefix — calls to /api/admin/*
// auto-attach gb_admin_token; everything else uses zm_token. So no API
// helper needs scope-awareness.

interface AdminAuthContextValue {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  login: (token: string | null, user: AuthUser | null) => void;
  logout: () => void;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

function readStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('gb_admin_token');
}

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const login = useCallback((nextToken: string | null, nextUser: AuthUser | null) => {
    if (typeof window !== 'undefined') {
      if (nextToken) window.localStorage.setItem('gb_admin_token', nextToken);
      if (nextUser) window.localStorage.setItem('gb_admin_user', JSON.stringify(nextUser));
    }
    setToken(nextToken || null);
    setUser(nextUser || null);
  }, []);

  const logout = useCallback(() => {
    if (typeof window !== 'undefined') {
      // Only touch the admin keys — the restaurant session
      // (zm_token / zm_user) must remain untouched.
      window.localStorage.removeItem('gb_admin_token');
      window.localStorage.removeItem('gb_admin_user');
    }
    setToken(null);
    setUser(null);
    if (typeof window !== 'undefined') {
      window.location.replace('/admin/login');
    }
  }, []);

  useEffect(() => {
    setAdminLogoutFn(logout);
  }, [logout]);

  useEffect(() => {
    let cancelled = false;
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('gb_admin_token') : null;
    if (!stored) {
      setLoading(false);
      return () => {};
    }
    getAdminMe()
      .then((me) => {
        if (cancelled) return;
        setUser(me || null);
        if (me && typeof window !== 'undefined') {
          window.localStorage.setItem('gb_admin_user', JSON.stringify(me));
        }
      })
      .catch(() => {
        // 401 already handled by the apiClient response interceptor (which
        // dispatches to setAdminLogoutFn for /api/admin/* requests).
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Backend's admin /auth response sets user.role = 'admin' (per
  // routes/admin.js:53). isAdmin is true whenever an admin session is loaded.
  const isAdmin = user?.role === 'admin';

  const value: AdminAuthContextValue = {
    user,
    token,
    loading,
    isAuthenticated: Boolean(token),
    isAdmin,
    login,
    logout,
  };

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthContextValue {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) {
    throw new Error('useAdminAuth must be used within an AdminAuthProvider');
  }
  return ctx;
}

export default AdminAuthContext;
