'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import AdminProtectedRoute from '../../components/AdminProtectedRoute';
import Sidebar, { type NavItem } from '../../components/Sidebar';
import Navbar from '../../components/Navbar';
import { useAdminAuth } from '../../contexts/AdminAuthContext';
import { SocketProvider } from '../../components/shared/SocketProvider';
import LiveIndicator from '../../components/shared/LiveIndicator';
import RestaurantMessageButton from '../../components/admin/RestaurantMessageButton';

const NAV_ITEMS: NavItem[] = [
  { label: 'Overview',      icon: '📊', path: '/admin/overview' },
  { label: 'Flows',         icon: '🔄', path: '/admin/flows' },
  { label: 'Templates',     icon: '📄', path: '/admin/templates' },
  { label: 'Campaign Tpls', icon: '✨',       path: '/admin/campaign-templates' },
  { label: 'Applications',  icon: '📝', path: '/admin/applications' },
  { label: 'Restaurants',   icon: '🏪', path: '/admin/restaurants' },
  { label: 'Directory',     icon: '📖', path: '/admin/directory' },
  { label: 'Orders',        icon: '📦', path: '/admin/orders' },
  { label: 'Customers',     icon: '👥', path: '/admin/customers' },
  { label: 'Issues',        icon: '🚨', path: '/admin/issues' },
  { label: 'Referrals',     icon: '🎯', path: '/admin/referrals' },
  { label: 'Settlements',   icon: '💸', path: '/admin/settlements' },
  { label: 'Financials',    icon: '💰', path: '/admin/financials' },
  { label: 'Fees',          icon: '⚠️', path: '/admin/fees' },
  { label: 'Coupons',       icon: '🎫', path: '/admin/coupons' },
  { label: 'Coupon Codes',  icon: '🔖', path: '/admin/coupon-codes' },
  { label: 'Marketing',     icon: '📢', path: '/admin/marketing' },
  { label: 'Analytics',     icon: '📊', path: '/admin/analytics' },
  { label: 'Pincodes',      icon: '📍', path: '/admin/pincodes' },
  { label: 'Logs',          icon: '🔎', path: '/admin/logs' },
  { label: 'DLQ',           icon: '☠️',  path: '/admin/dlq' },
  { label: 'Sync Logs',     icon: '🔁', path: '/admin/sync-logs' },
  { label: 'Activity',      icon: '🔴', path: '/admin/activity' },
  { label: 'Abuse',         icon: '🛡️', path: '/admin/abuse' },
  { label: 'Admins',        icon: '👤', path: '/admin/admins' },
  { label: 'Usernames',     icon: '🆔', path: '/admin/usernames' },
  { label: 'Logistics',     icon: '🚚', path: '/admin/logistics' },
  { label: 'Festivals',     icon: '🎉', path: '/admin/festivals' },
  { label: 'Platform Marketing', icon: '📈', path: '/admin/platform-marketing' },
];

const TITLE_BY_PATH: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.map((n) => [n.path, n.label]),
);

interface AdminShellProps { children: ReactNode }

function AdminShell({ children }: AdminShellProps) {
  const { logout } = useAdminAuth();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const title = TITLE_BY_PATH[pathname || ''] || 'Admin';

  return (
    <div id="pg-admin" style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar
        navItems={NAV_ITEMS}
        onLogout={logout}
        brandLabel="GullyBite Admin"
        brandIcon={'⚡'}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="main">
        <Navbar
          title={title}
          subtitle="Platform administration"
          onMenuClick={() => setSidebarOpen(true)}
          actions={
            <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
              <LiveIndicator />
              <RestaurantMessageButton />
            </div>
          }
        />
        <div className="body">
          {children}
        </div>
      </main>
    </div>
  );
}

interface AdminLayoutClientProps { children: ReactNode }

export default function AdminLayoutClient({ children }: AdminLayoutClientProps) {
  const pathname = usePathname();
  // /admin/login is unprotected and must not be wrapped in the admin shell.
  if (pathname === '/admin/login') return <>{children}</>;
  return (
    <AdminProtectedRoute redirectTo="/admin/login">
      <SocketProvider isAdmin>
        <AdminShell>{children}</AdminShell>
      </SocketProvider>
    </AdminProtectedRoute>
  );
}
