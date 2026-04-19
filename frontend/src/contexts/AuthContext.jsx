import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { getMe } from '../api/auth.js';
import { setLogoutFn } from './authStore.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('zm_token'));
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const login = useCallback((nextToken, nextUser) => {
    if (nextToken) localStorage.setItem('zm_token', nextToken);
    if (nextUser) localStorage.setItem('zm_user', JSON.stringify(nextUser));
    setToken(nextToken || null);
    setUser(nextUser || null);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('zm_token');
    localStorage.removeItem('zm_user');
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
    const stored = localStorage.getItem('zm_token');
    if (!stored) {
      setLoading(false);
      return () => {};
    }
    getMe()
      .then((me) => {
        if (cancelled) return;
        setUser(me || null);
        if (me) localStorage.setItem('zm_user', JSON.stringify(me));
      })
      .catch(() => {
        // 401 is already handled by the axios interceptor which calls logout().
        // Any other error: leave user null but clear loading so UI can render.
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

  const value = {
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

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export default AuthContext;
