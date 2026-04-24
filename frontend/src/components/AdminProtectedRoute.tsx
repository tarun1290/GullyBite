'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminAuth } from '../contexts/AdminAuthContext';
import { useToast } from './Toast';

// Mirror of components/ProtectedRoute.tsx, but reads from AdminAuthContext.
// Necessary because ProtectedRoute uses useAuth() which would always look at
// the restaurant context regardless of where it's rendered.

interface AdminProtectedRouteProps {
  children: ReactNode;
  redirectTo?: string;
}

function LoadingSpinner() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span className="spin" aria-label="Loading" />
    </div>
  );
}

export default function AdminProtectedRoute({
  children,
  redirectTo = '/admin/login',
}: AdminProtectedRouteProps) {
  const { isAuthenticated, loading, user } = useAdminAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const warnedRef = useRef(false);

  // Backend always returns role='admin' on the admin auth endpoint, but
  // guard anyway so a stale localStorage value from a different role
  // (e.g. someone manually swapped tokens) doesn't grant admin UI access.
  const roleMismatch = Boolean(user && user.role !== 'admin');

  useEffect(() => {
    if (roleMismatch && !warnedRef.current) {
      warnedRef.current = true;
      showToast('Access denied', 'error');
    }
  }, [roleMismatch, showToast]);

  useEffect(() => {
    if (loading) return;
    if (!isAuthenticated || roleMismatch) {
      router.replace(redirectTo);
    }
  }, [loading, isAuthenticated, roleMismatch, redirectTo, router]);

  if (loading || !isAuthenticated || roleMismatch) {
    return <LoadingSpinner />;
  }

  return <>{children}</>;
}
