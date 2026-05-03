'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import ProtectedRoute from '../../components/ProtectedRoute';
import Sidebar, { type NavItem } from '../../components/Sidebar';
import Navbar from '../../components/Navbar';
import WaConnectBanner from '../../components/dashboard/WaConnectBanner';
import WabaTokenExpiryBanner from '../../components/dashboard/WabaTokenExpiryBanner';
import WalletWidget from '../../components/dashboard/WalletWidget';
import NotificationBell from '../../components/dashboard/NotificationBell';
import AdminMessageButton from '../../components/dashboard/AdminMessageButton';
import { useAuth } from '../../contexts/AuthContext';
import { RestaurantProvider, useRestaurant } from '../../contexts/RestaurantContext';
import { useNewOrderSound } from '../../hooks/useNewOrderSound';
import { SocketProvider } from '../../components/shared/SocketProvider';
import LiveIndicator from '../../components/shared/LiveIndicator';
import NewOrderPopup from '../../components/restaurant/NewOrderPopup';
import type { Restaurant, WabaAccount } from '../../types';

const NAV_ITEMS: NavItem[] = [
  { label: 'Overview',            icon: '🏠', path: '/dashboard/overview' },
  { label: 'Orders',              icon: '📦', path: '/dashboard/orders' },
  { label: 'Menu',                icon: '🍽', path: '/dashboard/menu' },
  { label: 'Messages',            icon: '💬', path: '/dashboard/messages' },
  { label: 'Marketing',           icon: '📣', path: '/dashboard/marketing' },
  { label: 'Campaigns',           icon: '✨', path: '/dashboard/campaigns' },
  { label: 'Analytics',           icon: '📊', path: '/dashboard/analytics' },
  { label: 'Marketing Analytics', icon: '📈', path: '/dashboard/marketing-analytics' },
  { label: 'Ratings',             icon: '⭐', path: '/dashboard/ratings' },
  { label: 'Feedback',            icon: '💬', path: '/dashboard/feedback' },
  { label: 'Loyalty',             icon: '🎖', path: '/dashboard/loyalty' },
  { label: 'Customers',           icon: '👥', path: '/dashboard/customers' },
  { label: 'Payments',            icon: '💰', path: '/dashboard/payments' },
  { label: 'Penalties',           icon: '⚠️', path: '/dashboard/penalties' },
  { label: 'Settings',            icon: '⚙', path: '/dashboard/settings' },
  { label: 'Restaurant',          icon: '🏪', path: '/dashboard/restaurant' },
];

const TITLE_BY_PATH: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.map((n) => [n.path, n.label]),
);

// Mirrors initDash's waConnected computation in dashboard.html:2711.
function computeWaConnected(rest: Restaurant | null): boolean {
  if (!rest) return false;
  const waba = rest.waba_accounts as WabaAccount[] | undefined;
  return Boolean(rest.whatsapp_connected || rest.meta_user_id || (waba && waba.length > 0));
}

interface DashboardShellProps {
  children: ReactNode;
}

function DashboardShell({ children }: DashboardShellProps) {
  const { logout } = useAuth();
  const pathname = usePathname();
  const { restaurant, loading, refetch } = useRestaurant();
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  // Mount the new-order alarm hook here so the document-level
  // autoplay-unlock listener installs as soon as the dashboard renders
  // — by the time the user navigates to /orders, audio is unlocked.
  // Return value unused at this layer; the orders page calls
  // useNewOrderSound() again to drive playback (singleton inside).
  useNewOrderSound();

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const title = TITLE_BY_PATH[pathname || ''] || 'Dashboard';

  const businessName = (typeof restaurant?.business_name === 'string' && restaurant.business_name) || undefined;
  const ownerName = (typeof restaurant?.owner_name === 'string' && restaurant.owner_name) || undefined;
  const displayName =
    businessName ||
    restaurant?.brand_name ||
    ownerName ||
    'Restaurant';

  const waConnected = computeWaConnected(restaurant);
  const approvalStatus = (typeof restaurant?.approval_status === 'string' && restaurant.approval_status) || 'pending';
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
              <LiveIndicator />
              <AdminMessageButton />
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
          {children}
        </div>
      </main>
      {/* Window-in-window new-order popup. Mounted at the layout level
          so it appears on every dashboard route, not just /orders.
          Self-polling — feeds syncWithOrders() to the alarm hook so
          the audible alarm fires off the same detection. */}
      <NewOrderPopup />
    </div>
  );
}

interface DashboardLayoutClientProps {
  children: ReactNode;
}

export default function DashboardLayoutClient({ children }: DashboardLayoutClientProps) {
  return (
    <ProtectedRoute role="restaurant" redirectTo="/">
      <RestaurantProvider>
        <SocketProvider>
          <DashboardShell>{children}</DashboardShell>
        </SocketProvider>
      </RestaurantProvider>
    </ProtectedRoute>
  );
}
