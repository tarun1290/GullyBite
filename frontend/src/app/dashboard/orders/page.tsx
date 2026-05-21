'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OrderCard from '../../../components/restaurant/OrderCard';
import OrderDetailModal from '../../../components/restaurant/OrderDetailModal';
import { getOrders, updateOrderStatus, getStaffedBranches } from '../../../api/restaurant';
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
  ['EXPIRED_PAYMENT', '💸 Refunded (expired)'],
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
  // The provider handles the toast on `new_order`; here we only react
  // to the payload references changing to trigger a silent refetch so
  // the table updates without waiting for the 30s poll.
  // order_status_changed / new_paid_order also refetch so status flips
  // and payment-state changes propagate from the kitchen tablet or
  // webhooks.
  const { lastOrder, lastUpdated, lastPaid, lastDeliveryUpdate } = useSocketContext();
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
  useEffect(() => { if (lastDeliveryUpdate) silentRefetch(); }, [lastDeliveryUpdate, silentRefetch]);

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

  // Generic forward transitions (PREPARING → PACKED, etc.). PAID is
  // owned by the OrderCard's inline Accept/Decline buttons, which call
  // /accept and /decline directly — see handleAccepted / handleDeclined
  // below for the post-action notification path.
  const handleStatusChange = useCallback(
    async (orderId: string, nextStatus: string) => {
      setRowBusy((b) => ({ ...b, [orderId]: true }));
      try {
        await updateOrderStatus(orderId, nextStatus);
        markOrderActioned(orderId);
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

  // Post-success callbacks fired by OrderCard after its direct
  // /accept and /decline calls resolve. The API call has already
  // happened in the card; here we drive the side-effects the card
  // can't own — alarm silencing + a silent refetch so the table
  // reflects the server-side auto-advance (CONFIRMED → PREPARING) +
  // toast.
  //
  // PAID → CONFIRMED → PREPARING auto-advance now happens server-side
  // inside applyOrderAcceptance (services/orderAcceptance.js), so the
  // frontend no longer needs to chase it with a follow-up
  // updateOrderStatus call — the silent refetch picks up the final
  // status.
  const handleAccepted = useCallback(async (orderId: string) => {
    markOrderActioned(orderId);
    showToast('Order accepted ✓', 'success');
    await fetchOrders(filter, { silent: true });
  }, [fetchOrders, filter, showToast, markOrderActioned]);

  const handleDeclined = useCallback(async (orderId: string, refundId?: string | null) => {
    markOrderActioned(orderId);
    const refundNote = refundId ? ` (refund ${refundId})` : '';
    showToast(`Order declined${refundNote}`, 'success');
    await fetchOrders(filter, { silent: true });
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center mb-2.5">
        <label className="flex items-center gap-1.5 text-sm text-dim">
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="py-1 px-2 border border-rim rounded-md text-sm bg-ink2 text-tx"
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-dim">
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="py-1 px-2 border border-rim rounded-md text-sm bg-ink2 text-tx"
          />
        </label>
        {(fromDate || toDate) && (
          <button
            type="button"
            onClick={() => { setFromDate(''); setToDate(''); }}
            className="py-1 px-2.5 border border-rim rounded-md text-xs text-dim bg-transparent cursor-pointer"
          >
            Clear dates
          </button>
        )}
      </div>
      <div
        className="chips mt-3 flex flex-nowrap items-center overflow-x-auto gap-2 pb-1 mb-2.5 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        id="ochips"
      >
        {FILTER_CHIPS.map(([value, label]) => {
          const active = filter === value;
          const count = countMap[value] || 0;
          return (
            <button
              key={value}
              type="button"
              className={active ? 'chip on flex-shrink-0' : 'chip flex-shrink-0'}
              onClick={() => setFilter(value)}
            >
              {label}
              {count > 0 && (
                <span
                  className="text-xs font-bold rounded-full py-[0.05rem] px-1.5 ml-1.5 min-w-[16px] text-center inline-block bg-[var(--acc-glow)] text-acc"
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {!loading && orders.length > 0 && (
        <div className="text-xs text-dim mb-2.5 py-0 px-0.5">
          Showing {orders.length} orders · Last refreshed {refreshedLabel}
        </div>
      )}
      <div className="card">
        <div className="tbl">
          <div className="overflow-x-auto w-full">
          <table className="min-w-[800px]">
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
                  <td colSpan={8} className="text-center p-8">
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
                    onAccepted={handleAccepted}
                    onDeclined={handleDeclined}
                    onViewDetail={handleViewDetail}
                    busy={Boolean(rowBusy[o.id])}
                  />
                ))
              )}
            </tbody>
          </table>
          </div>
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
