'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OrderCard from '../../../components/restaurant/OrderCard';
import OrderDetailModal from '../../../components/restaurant/OrderDetailModal';
import { getOrders, updateOrderStatus, declineOrder, getStaffedBranches } from '../../../api/restaurant';
import { useToast } from '../../../components/Toast';
import { useNewOrderSound } from '../../../hooks/useNewOrderSound';
import { useSocketContext } from '../../../components/shared/SocketProvider';
import type { Order, OrderStatus } from '../../../types';

type FilterValue = OrderStatus | 'ALL';

// Mirrors dashboard.html:459-468 — 8 chip buttons including emoji prefix.
const FILTER_CHIPS: ReadonlyArray<readonly [FilterValue, string]> = [
  ['ALL',             'All'],
  ['PENDING_PAYMENT', '⏳ Awaiting Payment'],
  ['PAID',            '✅ Paid'],
  ['PREPARING',       '👨‍🍳 Preparing'],
  ['PACKED',          '📦 Packed'],
  ['DELIVERED',       '🎉 Delivered'],
  ['PAYMENT_FAILED',  '❌ Failed'],
  ['EXPIRED',         '⏱ Expired'],
];

// Legacy uses a WebSocket push to refresh the Orders tab (dashboard.html:2787-2844).
// WS infrastructure belongs in a later migration phase, so we fall back to a
// conservative 30s refresh so the table does not go stale while the tab is open.
const REFRESH_MS = 30000;

interface FetchOpts {
  silent?: boolean;
}

export default function OrdersPage() {
  const { showToast } = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState<FilterValue>('ALL');
  // Date range filter. Empty strings = unbounded; the API call below
  // skips `from_date` / `to_date` when the matching state is empty so
  // an empty range falls back to the full unfiltered list.
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  // New-order alarm. The hook diffs `orders` against its previous
  // snapshot — fires on PAID arrivals, silences on transitions out of
  // PAID. Respects the restaurant's `notification_settings.new_order`
  // preference internally. stopAll() runs on unmount so navigating
  // away from the orders tab silences any in-flight alarm.
  // markOrderActioned is the immediate-silence escape hatch — called
  // from handleStatusChange the moment updateOrderStatus resolves, so
  // the alarm stops on click rather than waiting for the silent
  // refetch + syncWithOrders round-trip (~100-300ms otherwise).
  const { syncWithOrders, stopAll, markOrderActioned, setStaffedBranches } = useNewOrderSound();

  // One-shot staff coverage fetch. Populates the hook's module-level
  // staffedBranchIds set so syncWithOrders can suppress the looping
  // alarm for branches with active order_management staff. Errors are
  // swallowed — the alarm remains in default "always-rings" mode if
  // the lookup fails, which is the safer fallback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getStaffedBranches();
        if (cancelled) return;
        setStaffedBranches(r.staffed_branch_ids || []);
      } catch {
        /* non-fatal — alarm falls back to fire-on-every-branch */
      }
    })();
    return () => { cancelled = true; };
  }, [setStaffedBranches]);

  const fetchOrders = useCallback(
    async (f: FilterValue, opts: FetchOpts = {}) => {
      const { silent = false } = opts;
      if (!silent) setLoading(true);
      try {
        const params: { limit: number; status?: string; from_date?: string; to_date?: string } = { limit: 60 };
        if (f !== 'ALL') params.status = f;
        if (fromDate) params.from_date = fromDate;
        if (toDate) params.to_date = toDate;
        const data = await getOrders(params);
        setOrders(Array.isArray(data) ? data : []);
        setLastFetched(Date.now());
      } catch (_e) {
        showToast('Failed to load orders', 'error');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    // fromDate / toDate in the dep list rebuilds the callback on each
    // change, which retriggers the [filter, fetchOrders]-keyed effect
    // below — that's how the date inputs drive an immediate refetch.
    [showToast, fromDate, toDate],
  );

  useEffect(() => {
    fetchOrders(filter);
    const id = setInterval(() => fetchOrders(filter, { silent: true }), REFRESH_MS);
    return () => clearInterval(id);
  }, [filter, fetchOrders]);

  // Socket.io live channel — sourced from SocketProvider context now,
  // so the connection itself is shared with every other dashboard page.
  // The provider handles the toast on `order:new`; here we only react
  // to the payload references changing to trigger a silent refetch so
  // the table updates without waiting for the 30s poll. order:updated
  // / order:paid also refetch so status flips and payment-state
  // changes propagate from the kitchen tablet or webhooks.
  const { lastOrder, lastUpdated, lastPaid } = useSocketContext();
  const silentRefetch = useCallback(() => {
    fetchOrders(filter, { silent: true });
  }, [fetchOrders, filter]);
  // useEffect deps trigger once per new event (each event sets a fresh
  // payload reference inside the provider). Initial null render is a
  // no-op since silentRefetch on a missing payload is fine — but we
  // still want to skip the very first effect to avoid double-fetching
  // alongside the explicit fetchOrders(filter) call above.
  useEffect(() => { if (lastOrder) silentRefetch(); }, [lastOrder, silentRefetch]);
  useEffect(() => { if (lastUpdated) silentRefetch(); }, [lastUpdated, silentRefetch]);
  useEffect(() => { if (lastPaid) silentRefetch(); }, [lastPaid, silentRefetch]);

  // Drive the new-order alarm off the polled orders list. Runs after
  // every `orders` change (initial fetch, 30s polls, post-action
  // refetches), so handleStatusChange silencing the alarm comes for
  // free — accept/decline -> updateOrderStatus -> fetchOrders ->
  // setOrders -> this effect -> syncWithOrders -> alarm stops. Final
  // stopAll() on unmount silences the alarm if the user navigates
  // away while a PAID order is still ringing.
  useEffect(() => {
    syncWithOrders(orders);
  }, [orders, syncWithOrders]);

  useEffect(() => {
    return () => { stopAll(); };
  }, [stopAll]);

  const handleStatusChange = useCallback(
    async (orderId: string, nextStatus: string) => {
      setRowBusy((b) => ({ ...b, [orderId]: true }));
      try {
        await updateOrderStatus(orderId, nextStatus);
        // Silence the alarm the moment the server confirms the
        // transition. Covers the accept path (PAID → CONFIRMED →
        // PREPARING; the auto-advance below) and any other status
        // change that flows through here. No-op when the order
        // wasn't ringing.
        markOrderActioned(orderId);
        // Auto-advance CONFIRMED → PREPARING. The owner dashboard
        // treats CONFIRMED as transient — the staff app keeps an
        // explicit prep button. Fire-and-forget: if this second call
        // fails, the order is already accepted on the server, so we
        // don't surface an error toast or block the row's success
        // path. A console.warn flags the gap for ops follow-up.
        if (nextStatus === 'CONFIRMED') {
          try {
            await updateOrderStatus(orderId, 'PREPARING');
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[orders] auto-advance to PREPARING failed:', err);
          }
        }
        showToast('Order updated ✓', 'success');
        await fetchOrders(filter, { silent: true });
      } catch (e: unknown) {
        const err = e as { response?: { data?: { error?: string } }; message?: string };
        showToast(err?.response?.data?.error || err?.message || 'Update failed', 'error');
      } finally {
        setRowBusy((b) => {
          const n = { ...b };
          delete n[orderId];
          return n;
        });
      }
    },
    [fetchOrders, filter, showToast, markOrderActioned],
  );

  const handleDecline = useCallback(async (orderId: string) => {
    if (!window.confirm('Decline this order? Customer will be refunded automatically.')) return;
    setRowBusy((b) => ({ ...b, [orderId]: true }));
    try {
      const res = await declineOrder(orderId);
      // Silence the alarm immediately on success — same posture as the
      // accept path in handleStatusChange above.
      markOrderActioned(orderId);
      const refundNote = res?.refundId ? ` (refund ${res.refundId})` : '';
      showToast(`Order declined${refundNote}`, 'success');
      await fetchOrders(filter, { silent: true });
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(err?.response?.data?.error || err?.message || 'Decline failed', 'error');
    } finally {
      setRowBusy((b) => {
        const n = { ...b };
        delete n[orderId];
        return n;
      });
    }
  }, [fetchOrders, filter, showToast, markOrderActioned]);

  const handleViewDetail = useCallback((orderId: string) => {
    setSelectedOrderId(orderId);
  }, []);

  const handleCloseModal = useCallback(() => {
    setSelectedOrderId(null);
  }, []);

  const handleStatusSync = useCallback(() => {
    fetchOrders(filter, { silent: true });
  }, [fetchOrders, filter]);

  // Count map drives the chip badges. Computed from the local `orders` array,
  // so non-ALL filters only populate their own bucket — accurate for "what's
  // visible right now," which is what the chip badges advertise.
  const countMap = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = { ALL: orders.length };
    for (const o of orders) {
      const s = o.status;
      if (s) m[s] = (m[s] || 0) + 1;
    }
    return m;
  }, [orders]);

  const refreshedLabel = (() => {
    if (!lastFetched) return '';
    const secs = Math.floor((Date.now() - lastFetched) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    return mins === 1 ? '1 min ago' : `${mins} min ago`;
  })();

  const emptyLabel = filter === 'ALL'
    ? 'No orders yet'
    : `No ${filter.toLowerCase().replace(/_/g, ' ')} orders yet`;

  return (
    <div id="tab-orders">
      <div
        style={{
          display: 'flex',
          gap: '.6rem',
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: '.6rem',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: '.35rem', fontSize: '.78rem', color: 'var(--dim)' }}>
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            style={{
              padding: '.3rem .5rem',
              border: '1px solid var(--rim,#e5e7eb)',
              borderRadius: 6,
              fontSize: '.84rem',
              background: 'var(--ink2,#fff)',
              color: 'var(--tx,inherit)',
            }}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '.35rem', fontSize: '.78rem', color: 'var(--dim)' }}>
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            style={{
              padding: '.3rem .5rem',
              border: '1px solid var(--rim,#e5e7eb)',
              borderRadius: 6,
              fontSize: '.84rem',
              background: 'var(--ink2,#fff)',
              color: 'var(--tx,inherit)',
            }}
          />
        </label>
        {(fromDate || toDate) && (
          <button
            type="button"
            onClick={() => { setFromDate(''); setToDate(''); }}
            style={{
              padding: '.3rem .6rem',
              border: '1px solid var(--rim,#e5e7eb)',
              borderRadius: 6,
              fontSize: '.74rem',
              color: 'var(--dim)',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            Clear dates
          </button>
        )}
      </div>
      <div className="chips" id="ochips">
        {FILTER_CHIPS.map(([value, label]) => {
          const active = filter === value;
          const count = countMap[value] || 0;
          return (
            <button
              key={value}
              type="button"
              className={active ? 'chip on' : 'chip'}
              onClick={() => setFilter(value)}
            >
              {label}
              {count > 0 && (
                <span
                  style={{
                    background: active ? 'var(--acc)' : 'var(--rim2)',
                    color: active ? '#fff' : 'var(--dim)',
                    fontSize: '.65rem',
                    fontWeight: 700,
                    borderRadius: 100,
                    padding: '.05rem .4rem',
                    marginLeft: '.2rem',
                    minWidth: 16,
                    textAlign: 'center',
                    display: 'inline-block',
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {!loading && orders.length > 0 && (
        <div style={{ fontSize: '.74rem', color: 'var(--dim)', marginBottom: '.6rem', padding: '0 .1rem' }}>
          Showing {orders.length} orders · Last refreshed {refreshedLabel}
        </div>
      )}
      <div className="card">
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Branch</th>
                <th>Total</th>
                <th>Status</th>
                <th>ETA</th>
                <th>Time</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="orders-body">
              {loading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem' }}>
                    <div className="spin" />
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty">
                      <div className="ei">🛵</div>
                      <h3>{emptyLabel}</h3>
                    </div>
                  </td>
                </tr>
              ) : (
                orders.map((o) => (
                  <OrderCard
                    key={o.id}
                    order={o}
                    onStatusChange={handleStatusChange}
                    onDecline={handleDecline}
                    onViewDetail={handleViewDetail}
                    busy={Boolean(rowBusy[o.id])}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedOrderId && (
        <OrderDetailModal
          orderId={selectedOrderId}
          onClose={handleCloseModal}
          onStatusSync={handleStatusSync}
        />
      )}
    </div>
  );
}
