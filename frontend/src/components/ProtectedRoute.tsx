'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from './Toast';

interface ProtectedRouteProps {
  children: ReactNode;
  role?: 'restaurant' | 'admin';
  redirectTo?: string;
}

function LoadingSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <span className="spin" aria-label="Loading" />
    </div>
  );
}

export default function ProtectedRoute({
  children,
  role,
  redirectTo = '/',
}: ProtectedRouteProps) {
  const { isAuthenticated, loading, user } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const warnedRef = useRef(false);

  const roleMismatch = Boolean(role && user && user.role !== role);

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

  // pathname is held for future state.from tracking on redirect.
  void pathname;

  if (loading || !isAuthenticated || roleMismatch) {
    return <LoadingSpinner />;
  }

  return <>{children}</>;
}
