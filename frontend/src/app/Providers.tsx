'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from '../contexts/AuthContext';
import { ToastProvider } from '../components/Toast';

interface ProvidersProps {
  children: ReactNode;
}

// Global provider nesting: ToastProvider → AuthProvider. The restaurant-
// scoped provider is mounted inside the dashboard layout instead — it
// fetches /api/restaurant on mount and would 401 on public pages
// (landing, login, store) where no token is set.
export default function Providers({ children }: ProvidersProps) {
  return (
    <ToastProvider>
      <AuthProvider>{children}</AuthProvider>
    </ToastProvider>
  );
}
