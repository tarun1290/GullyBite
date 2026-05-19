'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import StatCard from '../../../components/StatCard';
import SetupWizard, { type WizardStep } from '../../../components/restaurant/SetupWizard';
import { StatusBadge } from '../../../components/restaurant/OrderCard';
import { useRestaurant } from '../../../contexts/RestaurantContext';
import { useSocketContext } from '../../../components/shared/SocketProvider';
import {
  getAnalyticsSummary,
  getBranches,
  getMenuAll,
  getRestaurantOrders,
} from '../../../api/restaurant';
import type { AnalyticsSummary, Branch, MenuAllResponse, Order, Restaurant, WabaAccount } from '../../../types';

function isWaConnected(rest: Restaurant | null): boolean {
  if (!rest) return false;
  const waba = rest.waba_accounts as WabaAccount[] | undefined;
  return Boolean(rest.whatsapp_connected || rest.meta_user_id || (waba && waba.length > 0));
}

function customerLabel(order: Order): string {
  if (order.customer_name) return order.customer_name;
  if (order.wa_phone) return order.wa_phone;
  if (order.bsuid) return `${String(order.bsuid).slice(0, 12)}…`;
  return '—';
}

export default function OverviewPage() {
  const router = useRouter();
  const { restaurant, loading: restLoading, refetch: refetchRestaurant } = useRestaurant();

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [d7, setD7] = useState<AnalyticsSummary | null>(null);
  const [recent, setRecent] = useState<Order[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [menuTotal, setMenuTotal] = useState<number>(0);
  // Optimistic offset added to today's counters between a new_paid_order
  // and the resync that follows it. Reset to zero once the refetched
  // analytics already include the order (see resyncStats).
  const [optimistic, setOptimistic] = useState<{ revenue: number; orders: number }>({ revenue: 0, orders: 0 });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summary7, orders, branchList, menu] = await Promise.all([
        getAnalyticsSummary(7).catch(() => null),
        getRestaurantOrders({ limit: 5 }).catch(() => []),
        getBranches().catch(() => []),
        getMenuAll().catch(() => ({ total_count: 0 } as MenuAllResponse)),
      ]);
      setD7(summary7);
      setRecent(Array.isArray(orders) ? orders : []);
      setBranches(Array.isArray(branchList) ? branchList : []);
      setMenuTotal(menu?.total_count || 0);
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      setError(e?.userMessage || e?.message || 'Could not load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Socket.io live channel — sourced from SocketProvider context so
  // we share one connection with every other dashboard page. When a
  // new order arrives or a payment is confirmed we refresh the
  // recent-orders list AND the days=7 analytics (which drives the
  // headline today/this-week counters) in parallel — but NOT the
  // menu, which doesn't change per order, so re-running the full
  // loadAll() on every socket event needlessly re-fetched the menu
  // endpoint. Generic 'order_status_changed' transitions are
  // intentionally ignored here.
  const { lastOrder, lastPaid, lastDelta, statsVersion } = useSocketContext();
  const refreshOrders = useCallback(async () => {
    const [orders, summary7] = await Promise.all([
      getRestaurantOrders({ limit: 5 }).catch(() => []),
      getAnalyticsSummary(7).catch(() => null),
    ]);
    setRecent(Array.isArray(orders) ? orders : []);
    setD7(summary7);
  }, []);
  useEffect(() => { if (lastOrder) void refreshOrders(); }, [lastOrder, refreshOrders]);
  useEffect(() => { if (lastPaid) void refreshOrders(); }, [lastPaid, refreshOrders]);

  // Live counter convergence. statsVersion bumps on every
  // new_paid_order / order_status_changed → full resync, which then
  // clears the optimistic offset (the refetched analytics already
  // include the order, so keeping the offset would double-count). The
  // lastDelta effect applies the instant bump while that refetch is in
  // flight. A 5-min interval backstops any missed socket event.
  // Initial load (loadAll) and the lastOrder/lastPaid effects above are
  // intentionally left unchanged.
  const resyncStats = useCallback(async () => {
    await refreshOrders();
    setOptimistic({ revenue: 0, orders: 0 });
  }, [refreshOrders]);
  useEffect(() => {
    if (lastDelta) {
      setOptimistic((p) => ({
        revenue: p.revenue + lastDelta.revenue,
        orders: p.orders + lastDelta.orderCount,
      }));
    }
  }, [lastDelta]);
  useEffect(() => {
    if (statsVersion === 0) return;
    void resyncStats();
  }, [statsVersion, resyncStats]);
  useEffect(() => {
    const id = setInterval(() => { void resyncStats(); }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [resyncStats]);

  const waConnected = isWaConnected(restaurant);
  const profileDone = Boolean(restaurant?.brand_name && restaurant?.phone);
  const hasBranch = branches.length > 0;
  const hasMenu = hasBranch && menuTotal > 0;
  const hasCatalog = Boolean(restaurant?.meta_catalog_id || restaurant?.catalog_id);

  const steps: WizardStep[] = useMemo(() => ([
    { id: 'wa',      label: 'Connect WhatsApp Business', description: 'Link your WhatsApp Business account via Meta',         done: waConnected,             cta: 'wa-connect' },
    { id: 'profile', label: 'Complete your profile',     description: 'Business name, logo, bank account',                    done: profileDone,             onAction: () => router.push('/dashboard/settings') },
    { id: 'branch',  label: 'Add your first branch',     description: 'GPS coordinates enable location-based ordering',       done: hasBranch,               onAction: () => router.push('/dashboard/menu') },
    { id: 'menu',    label: 'Add menu items',            description: 'Items sync to WhatsApp Catalog automatically',         done: hasMenu,                 onAction: () => router.push('/dashboard/menu') },
    { id: 'catalog', label: 'Sync catalog & go live',    description: 'Catalog syncs automatically when you add items',       done: hasCatalog && hasMenu,   onAction: () => router.push('/dashboard/menu') },
  ]), [waConnected, profileDone, hasBranch, hasMenu, hasCatalog, router]);

  const handleWaConnected = useCallback(async () => {
    await refetchRestaurant();
    await loadAll();
  }, [refetchRestaurant, loadAll]);

  if (loading || restLoading) {
    return (
      <div id="tab-overview" className="tab on">
        <div className="stats">
          <StatCard label="Today's Orders"  value="—" delta="Loading…" color="indigo" />
          <StatCard label="Today's Revenue" value="—" delta="Loading…" color="green"  />
          <StatCard label="This Week"       value="—" delta="Loading…" color="amber"  />
          <StatCard label="In Progress"     value="—" delta="Loading…" color="indigo" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div id="tab-overview" className="tab on">
        <div className="card p-5 text-center">
          <h3 className="mb-2">Could not load overview</h3>
          <p className="text-dim mb-3">{error}</p>
          <button type="button" className="btn-g btn-sm" onClick={loadAll}>Retry</button>
        </div>
      </div>
    );
  }

  // Today's numbers are derived from the last entry of the days=7
  // daily breakdown (backend sorts ascending → last = most recent
  // date), avoiding a separate days=1 analytics round-trip.
  // `daily` is untyped on AnalyticsSummary (open index signature), so
  // it's narrowed locally. Per the backend handler: `orders` counts
  // all statuses for the day; `revenue` is delivered-only — matching
  // the "All statuses" / "Delivered only" StatCard labels below.
  const daily = (d7?.daily as Array<{ date: string; orders: number; revenue: number }> | undefined) ?? [];
  const todayBucket = daily.length > 0 ? daily[daily.length - 1] : null;
  const todayOrders = (todayBucket?.orders ?? 0) + optimistic.orders;
  const todayRevenue = `₹${Math.round((todayBucket?.revenue ?? 0) + optimistic.revenue)}`;
  const weekOrders = d7?.summary?.total_orders ?? 0;

  return (
    <div id="tab-overview" className="tab on">
      <SetupWizard steps={steps} onWaConnected={handleWaConnected} />

      <div className="stats">
        <StatCard label="Today's Orders"  value={todayOrders}  delta="All statuses"   color="indigo" />
        <StatCard label="Today's Revenue" value={todayRevenue} delta="Delivered only" color="green"  />
        <StatCard label="This Week"       value={weekOrders}   delta="Total orders"   color="amber"  />
        <StatCard label="In Progress"     value="—"            delta="Active orders"  color="indigo" />
      </div>

      <div className="card">
        <div className="ch">
          <h3>Recent Orders</h3>
          <button type="button" className="btn-g btn-sm" onClick={() => router.push('/dashboard/orders')}>
            View All →
          </button>
        </div>
        {recent.length === 0 ? (
          <div id="recent-body">
            <div className="empty">
              <div className="ei">🛵</div>
              <h3>No orders yet</h3>
              <p>Orders placed through WhatsApp will appear here</p>
            </div>
          </div>
        ) : (
          <div id="recent-body">
            <div className="tbl tbl-card">
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Total</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.id || r.order_number}>
                      <td data-label="Order"><span className="mono">{r.order_number}</span></td>
                      <td data-label="Customer">{customerLabel(r)}</td>
                      <td data-label="Total">₹{r.total_rs}</td>
                      <td data-label="Status"><StatusBadge status={r.status} /></td>
                      <td data-label="Time">
                        {r.created_at
                          ? new Date(r.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
