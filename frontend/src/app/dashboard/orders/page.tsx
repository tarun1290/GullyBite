'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OrderCard from '../../../components/dashboard/OrderCard';
import OrderDetailModal from '../../../components/dashboard/OrderDetailModal';
import { getOrders, updateOrderStatus } from '../../../api/restaurant';
import { useToast } from '../../../components/Toast';
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
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  const fetchOrders = useCallback(
    async (f: FilterValue, opts: FetchOpts = {}) => {
      const { silent = false } = opts;
      if (!silent) setLoading(true);
      try {
        const params: { limit: number; status?: string } = { limit: 60 };
        if (f !== 'ALL') params.status = f;
        const data = await getOrders(params);
        setOrders(Array.isArray(data) ? data : []);
        setLastFetched(Date.now());
      } catch (_e) {
        showToast('Failed to load orders', 'error');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    fetchOrders(filter);
    const id = setInterval(() => fetchOrders(filter, { silent: true }), REFRESH_MS);
    return () => clearInterval(id);
  }, [filter, fetchOrders]);

  const handleStatusChange = useCallback(
    async (orderId: string, nextStatus: string) => {
      setRowBusy((b) => ({ ...b, [orderId]: true }));
      try {
        await updateOrderStatus(orderId, nextStatus);
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
    [fetchOrders, filter, showToast],
  );

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
