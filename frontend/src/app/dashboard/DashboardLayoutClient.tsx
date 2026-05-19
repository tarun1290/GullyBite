'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import ProtectedRoute from '../../components/ProtectedRoute';
import Sidebar, { type NavItem, type NavGroup } from '../../components/Sidebar';
import Navbar from '../../components/Navbar';
import WaConnectBanner from '../../components/restaurant/WaConnectBanner';
import WabaTokenExpiryBanner from '../../components/restaurant/WabaTokenExpiryBanner';
import WalletWidget from '../../components/restaurant/WalletWidget';
import NotificationBell from '../../components/restaurant/NotificationBell';
import AdminMessageButton from '../../components/restaurant/AdminMessageButton';
import { useAuth } from '../../contexts/AuthContext';
import { RestaurantProvider, useRestaurant } from '../../contexts/RestaurantContext';
import { useNewOrderSound } from '../../hooks/useNewOrderSound';
import { SocketProvider } from '../../components/shared/SocketProvider';
import LiveIndicator from '../../components/shared/LiveIndicator';
import NewOrderPopup from '../../components/restaurant/NewOrderPopup';
import ReAcceptTermsModal from '../../components/shared/ReAcceptTermsModal';
import { TERMS_VERSION, PRIVACY_VERSION } from '../../lib/constants/legal';
import type { Restaurant, WabaAccount } from '../../types';

// Restaurant sidebar nav, grouped. Each group renders a small header in
// the Sidebar; items keep their { label, icon, path } shape and order.
const NAV_GROUPS: NavGroup[] = [
  { header: 'OPERATIONS', items: [
    { label: 'Overview', icon: '🏠', path: '/dashboard/overview' },
    { label: 'Orders',   icon: '📦', path: '/dashboard/orders' },
    { label: 'Menu',     icon: '🍽', path: '/dashboard/menu' },
    { label: 'Messages', icon: '💬', path: '/dashboard/messages' },
  ] },
  { header: 'MARKETING', items: [
    { label: 'Marketing', icon: '✨', path: '/dashboard/marketing' },
  ] },
  { header: 'ANALYTICS', items: [
    { label: 'Analytics',  icon: '📊', path: '/dashboard/analytics' },
    { label: 'Reputation', icon: '⭐', path: '/dashboard/reputation' },
  ] },
  { header: 'FINANCE', items: [
    { label: 'Payments', icon: '💰', path: '/dashboard/payments' },
  ] },
  { header: 'SETTINGS', items: [
    { label: 'Settings', icon: '⚙', path: '/dashboard/settings' },
  ] },
];

// Captain growth surfaces — only shown when WhatsApp is connected (the
// captain feature is gated on a working WABA). Spliced in as a dedicated
// 'GROWTH' group positioned between MARKETING and ANALYTICS (mid-funnel:
// listing + referrals sit between acquisition and measurement). The
// splice is driven by GROUP POSITION (header === 'MARKETING'), not a
// route-path anchor, so it can't silently break when routes move again.
//
// captain-listing was folded into the Referrals tab (Prompt 6); this
// entry deep-links straight to that tab via ?tab=referrals.
const CAPTAIN_NAV_ITEMS: NavItem[] = [
  { label: 'GullyBite Referrals', icon: '🔗', path: '/dashboard/marketing?tab=referrals' },
];

const GROWTH_GROUP: NavGroup = { header: 'GROWTH', items: CAPTAIN_NAV_ITEMS };

// Navbar title per route. Keyed by pathname (usePathname() strips the
// query) — captain entries carry a query string so they never collide
// with the bare /dashboard/marketing → 'Marketing' mapping.
const TITLE_BY_PATH: Record<string, string> = {
  ...Object.fromEntries(
    NAV_GROUPS.flatMap((g) => g.items).map((n) => [n.path, n.label]),
  ),
  ...Object.fromEntries(CAPTAIN_NAV_ITEMS.map((n) => [n.path, n.label])),
};

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

  // ── Terms & Privacy re-acceptance gate ──
  // When the published legal versions are bumped (e.g. the post-Meta-App-
  // Review transition out of beta), every logged-in restaurant whose
  // stored consent is older must re-accept before using the dashboard.
  // Date-formatted versions ("2026-05-18") compare correctly with simple
  // string inequality. A missing consent (legacy pre-consent account)
  // also gates. `reAcceptDone` suppresses the modal for the rest of the
  // session once acceptance succeeds, even if the profile refetch lags.
  const [reAcceptDone, setReAcceptDone] = useState<boolean>(false);
  const consent = restaurant?.consent;
  const needsReAccept =
    !loading &&
    !!restaurant &&
    !reAcceptDone &&
    (!consent ||
      !consent.terms_version ||
      consent.terms_version < TERMS_VERSION ||
      !consent.privacy_version ||
      consent.privacy_version < PRIVACY_VERSION);
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

  // When WA is connected, insert the GROWTH group immediately after the
  // MARKETING group. Driven by group position (the MARKETING header),
  // NOT a route-path anchor — route moves can't break this again.
  const navGroups = useMemo<NavGroup[]>(() => {
    if (!waConnected) return NAV_GROUPS;
    const out: NavGroup[] = [];
    for (const grp of NAV_GROUPS) {
      out.push(grp);
      if (grp.header === 'MARKETING') out.push(GROWTH_GROUP);
    }
    return out;
  }, [waConnected]);

  const approvalStatus = (typeof restaurant?.approval_status === 'string' && restaurant.approval_status) || 'pending';
  // Hide the top banner while the profile is still loading to avoid a flash
  // of "not connected" before the first response arrives.
  const showWaBanner = !loading && !waConnected;
  const showPendingBanner = !loading && waConnected && approvalStatus !== 'approved';

  return (
    <div id="pg-dash" className="flex min-h-screen">
      <ReAcceptTermsModal
        open={needsReAccept}
        onAccepted={() => {
          setReAcceptDone(true);
          void refetch();
        }}
        onLogout={logout}
      />
      <Sidebar
        navGroups={navGroups}
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
            <div className="flex items-center gap-2.5">
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
            className="flex items-center gap-3 bg-[#f0f9ff] border-b border-[#bae6fd] py-3 px-8"
          >
            <span className="text-lg">⏳</span>
            <span className="text-sm text-[#0369a1]">
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
