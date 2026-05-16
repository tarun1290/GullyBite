'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import AdminProtectedRoute from '../../components/AdminProtectedRoute';
import Sidebar, { type NavGroup } from '../../components/Sidebar';
import Navbar from '../../components/Navbar';
import { useAdminAuth } from '../../contexts/AdminAuthContext';
import { SocketProvider } from '../../components/shared/SocketProvider';
import LiveIndicator from '../../components/shared/LiveIndicator';
import RestaurantMessageButton from '../../components/admin/RestaurantMessageButton';

// Sidebar nav, organised into 9 named sections (Sidebar.tsx renders the
// `header` as a group label and skips the header for empty groups). Each
// item keeps its original { label, icon, path }. Two labels were renamed
// here: 'Campaign Tpls' → 'Campaign Templates' and 'Marketing'
// (/admin/marketing) → 'Message Logs' (now grouped under MONITORING).
// NOTE: '/admin/branch-approvals' is not enumerated in the section spec;
// it is a restaurant-branch onboarding surface so it lives in RESTAURANTS
// (after Restaurants) rather than being dropped from the nav.
const NAV_GROUPS: NavGroup[] = [
  {
    header: 'OVERVIEW',
    items: [
      { label: 'Overview', icon: '📊', path: '/admin/overview' },
    ],
  },
  {
    header: 'RESTAURANTS',
    items: [
      { label: 'Applications',     icon: '📝', path: '/admin/applications' },
      { label: 'Restaurants',      icon: '🏪', path: '/admin/restaurants' },
      { label: 'Branch Approvals', icon: '✅', path: '/admin/branch-approvals' },
      { label: 'Cities',           icon: '🏙️', path: '/admin/cities' },
      { label: 'Pincodes',         icon: '📍', path: '/admin/pincodes' },
    ],
  },
  {
    header: 'ORDERS & SUPPORT',
    items: [
      { label: 'Orders',            icon: '📦', path: '/admin/orders' },
      { label: 'Customers',         icon: '👥', path: '/admin/customers' },
      { label: 'Issues',            icon: '🚨', path: '/admin/issues' },
      { label: 'Delivery Disputes', icon: '⚠️', path: '/admin/delivery-disputes' },
    ],
  },
  {
    header: 'MARKETPLACE',
    items: [
      { label: 'Directory',      icon: '📖', path: '/admin/directory' },
      { label: 'Referrals',      icon: '🎯', path: '/admin/referrals' },
      { label: 'Personas',       icon: '👤', path: '/admin/personas' },
      { label: 'Captain Logs',   icon: '📜', path: '/admin/captain-logs' },
      { label: 'Tag Candidates', icon: '🏷️', path: '/admin/tag-candidates' },
      { label: 'Usernames',      icon: '🆔', path: '/admin/usernames' },
    ],
  },
  {
    header: 'ANALYTICS',
    items: [
      { label: 'Analytics',          icon: '📊', path: '/admin/analytics' },
      { label: 'Logistics',          icon: '🚚', path: '/admin/logistics' },
      { label: 'Platform Analytics', icon: '📈', path: '/admin/platform-analytics' },
    ],
  },
  {
    header: 'MARKETING',
    items: [
      { label: 'Templates',          icon: '📄', path: '/admin/templates' },
      { label: 'Campaign Templates', icon: '✨', path: '/admin/campaign-templates' },
      { label: 'Flows',              icon: '🔄', path: '/admin/flows' },
      { label: 'Coupons',            icon: '🎫', path: '/admin/coupons' },
      { label: 'Festivals',          icon: '🎉', path: '/admin/festivals' },
    ],
  },
  {
    header: 'FINANCIALS',
    items: [
      { label: 'Financials',      icon: '💰', path: '/admin/financials' },
      { label: 'Payouts',         icon: '💸', path: '/admin/settlements' },
      { label: 'Fee Attribution', icon: '⚠️', path: '/admin/fees' },
    ],
  },
  {
    header: 'MONITORING',
    items: [
      { label: 'Logs',         icon: '🔎', path: '/admin/logs' },
      { label: 'DLQ',          icon: '☠️',  path: '/admin/dlq' },
      { label: 'Sync Logs',    icon: '🔁', path: '/admin/sync-logs' },
      { label: 'Activity',     icon: '🔴', path: '/admin/activity' },
      { label: 'Abuse',        icon: '🛡️', path: '/admin/abuse' },
      { label: 'Message Logs', icon: '📢', path: '/admin/marketing' },
    ],
  },
  {
    header: 'SETTINGS',
    items: [
      { label: 'Platform Settings', icon: '⚙️', path: '/admin/settings' },
      { label: 'Admins',            icon: '👤', path: '/admin/admins' },
    ],
  },
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

// Role filtering is applied PER GROUP and empty groups are dropped, so a
// restricted role still sees its surfaces under the relevant section
// headers (e.g. city_ops → Cities under RESTAURANTS, Personas under
// MARKETPLACE). CITY_OPS_PATHS / SALES_PATHS membership and the sales
// "(read-only)" relabel are unchanged from the prior flat behaviour.
function navGroupsForRole(role: string | undefined | null): NavGroup[] {
  if (role === 'city_ops') {
    return NAV_GROUPS
      .map((g) => ({ ...g, items: g.items.filter((n) => CITY_OPS_PATHS.has(n.path)) }))
      .filter((g) => g.items.length > 0);
  }
  if (role === 'sales') {
    return NAV_GROUPS
      .map((g) => ({
        ...g,
        items: g.items
          .filter((n) => SALES_PATHS.has(n.path))
          .map((n) => ({ ...n, label: `${n.label} (read-only)` })),
      }))
      .filter((g) => g.items.length > 0);
  }
  return NAV_GROUPS;
}

const TITLE_BY_PATH: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items).map((n) => [n.path, n.label]),
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
  const navGroups = navGroupsForRole(adminUser?.role);

  return (
    <div id="pg-admin" className="flex min-h-screen">
      <Sidebar
        navGroups={navGroups}
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
