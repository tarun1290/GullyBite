import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar.jsx';
import Navbar from '../components/Navbar.jsx';
import WaConnectBanner from '../components/dashboard/WaConnectBanner.jsx';
import WabaTokenExpiryBanner from '../components/dashboard/WabaTokenExpiryBanner.jsx';
import WalletWidget from '../components/dashboard/WalletWidget.jsx';
import NotificationBell from '../components/dashboard/NotificationBell.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { RestaurantProvider, useRestaurant } from '../contexts/RestaurantContext.jsx';

const NAV_ITEMS = [
  { label: 'Overview',   icon: '\uD83C\uDFE0', path: '/dashboard/overview' },
  { label: 'Orders',     icon: '\uD83D\uDCE6', path: '/dashboard/orders' },
  { label: 'Menu',       icon: '\uD83C\uDF7D', path: '/dashboard/menu' },
  { label: 'Messages',   icon: '\uD83D\uDCAC', path: '/dashboard/messages' },
  { label: 'Marketing',  icon: '\uD83D\uDCE3', path: '/dashboard/marketing' },
  { label: 'Campaigns',  icon: '\u2728',       path: '/dashboard/campaigns' },
  { label: 'Analytics',  icon: '\uD83D\uDCCA', path: '/dashboard/analytics' },
  { label: 'Marketing Analytics', icon: '\uD83D\uDCC8', path: '/dashboard/marketing-analytics' },
  { label: 'Ratings',    icon: '\u2B50',       path: '/dashboard/ratings' },
  { label: 'Feedback',   icon: '\uD83D\uDCAC', path: '/dashboard/feedback' },
  { label: 'Loyalty',    icon: '\uD83C\uDF96', path: '/dashboard/loyalty' },
  { label: 'Customers',  icon: '\uD83D\uDC65', path: '/dashboard/customers' },
  { label: 'Payments',   icon: '\uD83D\uDCB0', path: '/dashboard/payments' },
  { label: 'Settings',   icon: '\u2699',       path: '/dashboard/settings' },
  { label: 'Restaurant', icon: '\uD83C\uDFEA', path: '/dashboard/restaurant' },
];

const TITLE_BY_PATH = Object.fromEntries(NAV_ITEMS.map((n) => [n.path, n.label]));

// Mirrors initDash's waConnected computation in dashboard.html:2711.
function computeWaConnected(rest) {
  if (!rest) return false;
  return !!(rest.whatsapp_connected || rest.meta_user_id || (rest.waba_accounts && rest.waba_accounts.length > 0));
}

function DashboardShell() {
  const { logout } = useAuth();
  const location = useLocation();
  const { restaurant, loading, refetch } = useRestaurant();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const title = TITLE_BY_PATH[location.pathname] || 'Dashboard';

  const displayName =
    restaurant?.business_name ||
    restaurant?.brand_name ||
    restaurant?.owner_name ||
    'Restaurant';

  const waConnected = computeWaConnected(restaurant);
  const approvalStatus = restaurant?.approval_status || 'pending';
  // Hide the top banner while the profile is still loading to avoid a flash
  // of "not connected" before the first response arrives.
  const showWaBanner = !loading && !waConnected;
  const showPendingBanner = !loading && waConnected && approvalStatus !== 'approved';

  return (
    <div id="pg-dash" style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar
        navItems={NAV_ITEMS}
        onLogout={logout}
        restaurantName={displayName}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="main">
        <Navbar
          title={title}
          subtitle="Welcome back"
          onMenuClick={() => setSidebarOpen(true)}
          actions={
            <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
              <NotificationBell />
              <WalletWidget />
            </div>
          }
        />
        {showWaBanner && <WaConnectBanner onConnected={refetch} />}
        {showPendingBanner && (
          <div
            id="pending-banner"
            style={{
              display: 'flex', alignItems: 'center', gap: '.7rem',
              background: '#f0f9ff', borderBottom: '1px solid #bae6fd',
              padding: '.75rem 2rem',
            }}
          >
            <span style={{ fontSize: '1.1rem' }}>⏳</span>
            <span style={{ fontSize: '.82rem', color: '#0369a1' }}>
              <strong>Account under review</strong> — Our team will activate your account within 1–2 business days. You can explore the dashboard in the meantime.
            </span>
          </div>
        )}
        <WabaTokenExpiryBanner />
        <div className="body">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export default function DashboardLayout() {
  return (
    <RestaurantProvider>
      <DashboardShell />
    </RestaurantProvider>
  );
}
