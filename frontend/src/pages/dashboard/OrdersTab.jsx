import { useCallback, useEffect, useState } from 'react';
import OrderCard from '../../components/dashboard/OrderCard.jsx';
import OrderDetailModal from '../../components/dashboard/OrderDetailModal.jsx';
import { getOrders, updateOrderStatus } from '../../api/restaurant.js';
import { useToast } from '../../components/Toast.jsx';

// Mirrors dashboard.html:459-468 — 8 chip buttons including emoji prefix.
const FILTER_CHIPS = [
  ['ALL',             'All'],
  ['PENDING_PAYMENT', '⏳ Awaiting Payment'],
  ['PAID',            '✅ Paid'],
  ['PREPARING',       '👨\u200D🍳 Preparing'],
  ['PACKED',          '📦 Packed'],
  ['DELIVERED',       '🎉 Delivered'],
  ['PAYMENT_FAILED',  '❌ Failed'],
  ['EXPIRED',         '⏱ Expired'],
];

// Legacy uses a WebSocket push to refresh the Orders tab (dashboard.html:2787-2844).
// WS infrastructure belongs in a later migration phase, so we fall back to a
// conservative 30s refresh so the table does not go stale while the tab is open.
const REFRESH_MS = 30000;

export default function OrdersTab() {
  const { showToast } = useToast();
  const [orders, setOrders] = useState([]);
  const [filter, setFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [rowBusy, setRowBusy] = useState({});

  const fetchOrders = useCallback(
    async (f, opts = {}) => {
      const { silent = false } = opts;
      if (!silent) setLoading(true);
      try {
        const params = { limit: 60 };
        if (f !== 'ALL') params.status = f;
        const data = await getOrders(params);
        setOrders(Array.isArray(data) ? data : []);
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
    async (orderId, nextStatus) => {
      setRowBusy((b) => ({ ...b, [orderId]: true }));
      try {
        await updateOrderStatus(orderId, nextStatus);
        showToast('Order updated \u2713', 'success');
        await fetchOrders(filter, { silent: true });
      } catch (e) {
        showToast(e?.response?.data?.error || e.message || 'Update failed', 'error');
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

  const handleViewDetail = useCallback((orderId) => {
    setSelectedOrderId(orderId);
  }, []);

  const handleCloseModal = useCallback(() => {
    setSelectedOrderId(null);
  }, []);

  const handleStatusSync = useCallback(() => {
    fetchOrders(filter, { silent: true });
  }, [fetchOrders, filter]);

  return (
    <div id="tab-orders">
      <div className="chips" id="ochips">
        {FILTER_CHIPS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={filter === value ? 'chip on' : 'chip'}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
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
                      <div className="ei">📋</div>
                      <h3>No orders found</h3>
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
                    busy={!!rowBusy[o.id]}
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
