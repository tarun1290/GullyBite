import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar.jsx';
import Navbar from '../components/Navbar.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';

const NAV_ITEMS = [
  { label: 'Overview',      icon: '\uD83D\uDCCA', path: '/admin/overview' },
  { label: 'Flows',         icon: '\uD83D\uDD04', path: '/admin/flows' },
  { label: 'Templates',     icon: '\uD83D\uDCC4', path: '/admin/templates' },
  { label: 'Campaign Tpls', icon: '\u2728',       path: '/admin/campaign-templates' },
  { label: 'Applications',  icon: '\uD83D\uDCDD', path: '/admin/applications' },
  { label: 'Restaurants',   icon: '\uD83C\uDFEA', path: '/admin/restaurants' },
  { label: 'Directory',     icon: '\uD83D\uDCD6', path: '/admin/directory' },
  { label: 'Orders',        icon: '\uD83D\uDCE6', path: '/admin/orders' },
  { label: 'Customers',     icon: '\uD83D\uDC65', path: '/admin/customers' },
  { label: 'Issues',        icon: '\uD83D\uDEA8', path: '/admin/issues' },
  { label: 'Referrals',     icon: '\uD83C\uDFAF', path: '/admin/referrals' },
  { label: 'Settlements',   icon: '\uD83D\uDCB8', path: '/admin/settlements' },
  { label: 'Financials',    icon: '\uD83D\uDCB0', path: '/admin/financials' },
  { label: 'Coupons',       icon: '\uD83C\uDFAB', path: '/admin/coupons' },
  { label: 'Coupon Codes',  icon: '\uD83D\uDD16', path: '/admin/coupon-codes' },
  { label: 'Marketing',     icon: '\uD83D\uDCE2', path: '/admin/marketing' },
  { label: 'Analytics',     icon: '\uD83D\uDCCA', path: '/admin/analytics' },
  { label: 'Pincodes',      icon: '\uD83D\uDCCD', path: '/admin/pincodes' },
  { label: 'Logs',          icon: '\uD83D\uDD0E', path: '/admin/logs' },
  { label: 'DLQ',           icon: '\u2620\uFE0F',  path: '/admin/dlq' },
  { label: 'Sync Logs',     icon: '\uD83D\uDD01', path: '/admin/sync-logs' },
  { label: 'Activity',      icon: '\uD83D\uDD34', path: '/admin/activity' },
  { label: 'Abuse',         icon: '\uD83D\uDEE1\uFE0F', path: '/admin/abuse' },
  { label: 'Admins',        icon: '\uD83D\uDC64', path: '/admin/admins' },
  { label: 'Usernames',     icon: '\uD83C\uDD94', path: '/admin/usernames' },
  { label: 'Logistics',     icon: '\uD83D\uDE9A', path: '/admin/logistics' },
  { label: 'Festivals',     icon: '\uD83C\uDF89', path: '/admin/festivals' },
  { label: 'Platform Marketing', icon: '\uD83D\uDCC8', path: '/admin/platform-marketing' },
];

const TITLE_BY_PATH = Object.fromEntries(NAV_ITEMS.map((n) => [n.path, n.label]));

export default function AdminLayout() {
  const { logout } = useAuth();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const title = TITLE_BY_PATH[location.pathname] || 'Admin';

  return (
    <div id="pg-admin" style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar
        navItems={NAV_ITEMS}
        onLogout={logout}
        brandLabel="GullyBite Admin"
        brandIcon={'\u26A1'}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="main">
        <Navbar
          title={title}
          subtitle="Platform administration"
          onMenuClick={() => setSidebarOpen(true)}
        />
        <div className="body">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
