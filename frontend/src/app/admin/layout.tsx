import type { ReactNode } from 'react';
import { AdminAuthProvider } from '../../contexts/AdminAuthContext';
import AdminLayoutClient from './AdminLayoutClient';

// Wrap the admin subtree in its OWN auth provider so logout from the
// admin dashboard never touches the restaurant session (and vice versa).
// The two contexts coexist — the global AuthProvider in app/Providers.tsx
// still handles /login, /dashboard, etc.; this one only governs /admin/*.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AdminAuthProvider>
      <AdminLayoutClient>{children}</AdminLayoutClient>
    </AdminAuthProvider>
  );
}
