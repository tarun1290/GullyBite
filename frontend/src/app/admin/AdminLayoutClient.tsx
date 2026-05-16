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
  { label: 'Branch Approvals', icon: '✅', path: '/admin/branch-approvals' },
  { label: 'Cities',        icon: '🏙️', path: '/admin/cities' },
  { label: 'Tag Candidates', icon: '🏷️', path: '/admin/tag-candidates' },
  { label: 'Captain Logs',  icon: '📜', path: '/admin/captain-logs' },
  { label: 'Directory',     icon: '📖', path: '/admin/directory' },
  { label: 'Orders',        icon: '📦', path: '/admin/orders' },
  { label: 'Customers',     icon: '👥', path: '/admin/customers' },
  { label: 'Personas',      icon: '👤', path: '/admin/personas' },
  { label: 'Issues',        icon: '🚨', path: '/admin/issues' },
  { label: 'Delivery Disputes', icon: '⚠️', path: '/admin/delivery-disputes' },
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
  { label: 'Platform Settings',  icon: '⚙️',  path: '/admin/settings' },
];

// City Ops nav — city captains today see exactly the Cities surface
// (backend scopes the list to adminUser.cities for that role).
// `/admin/tag-candidates` is super_admin-only and stays out of this
// allowlist.
const CITY_OPS_PATHS: ReadonlySet<string> = new Set<string>([
  '/admin/cities',
  '/admin/personas',
]);

// Sales nav — read-only access to captain analytics + the restaurant
// list. Items keep their original icons but are relabeled with a
// "(read-only)" suffix so the constraint is visible in the sidebar.
const SALES_PATHS: ReadonlySet<string> = new Set<string>([
  '/admin/analytics',
  '/admin/restaurants',
]);

function navItemsForRole(role: string | undefined | null): NavItem[] {
  if (role === 'city_ops') {
    return NAV_ITEMS.filter((n) => CITY_OPS_PATHS.has(n.path));
  }
  if (role === 'sales') {
    return NAV_ITEMS
      .filter((n) => SALES_PATHS.has(n.path))
      .map((n) => ({ ...n, label: `${n.label} (read-only)` }));
  }
  return NAV_ITEMS;
}

const TITLE_BY_PATH: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.map((n) => [n.path, n.label]),
);

interface AdminShellProps { children: ReactNode }

function AdminShell({ children }: AdminShellProps) {
  const { logout, adminUser } = useAdminAuth();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const title = TITLE_BY_PATH[pathname || ''] || 'Admin';
  const navItems = navItemsForRole(adminUser?.role);

  return (
    <div id="pg-admin" className="flex min-h-screen">
      <Sidebar
        navItems={navItems}
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
            <div className="flex items-center gap-2.5">
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
