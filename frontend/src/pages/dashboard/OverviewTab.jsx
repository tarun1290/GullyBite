import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import StatCard from '../../components/StatCard.jsx';
import SetupWizard from '../../components/dashboard/SetupWizard.jsx';
import { useRestaurant } from '../../contexts/RestaurantContext.jsx';
import {
  getAnalyticsSummary,
  getBranches,
  getMenuAll,
  getRestaurantOrders,
} from '../../api/restaurant.js';

function isWaConnected(rest) {
  if (!rest) return false;
  return !!(rest.whatsapp_connected || rest.meta_user_id || (rest.waba_accounts && rest.waba_accounts.length > 0));
}

function formatOrderStatus(status) {
  if (!status) return '—';
  return String(status).replace(/_/g, ' ').toLowerCase();
}

function customerLabel(order) {
  if (order.customer_name) return order.customer_name;
  if (order.wa_phone) return order.wa_phone;
  if (order.bsuid) return `${String(order.bsuid).slice(0, 12)}…`;
  return '—';
}

export default function OverviewTab() {
  const navigate = useNavigate();
  const { restaurant, loading: restLoading, refetch: refetchRestaurant } = useRestaurant();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [d1, setD1] = useState(null);
  const [d7, setD7] = useState(null);
  const [recent, setRecent] = useState([]);
  const [branches, setBranches] = useState([]);
  const [menuTotal, setMenuTotal] = useState(0);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summary1, summary7, orders, branchList, menu] = await Promise.all([
        getAnalyticsSummary(1).catch(() => null),
        getAnalyticsSummary(7).catch(() => null),
        getRestaurantOrders({ limit: 5 }).catch(() => []),
        getBranches().catch(() => []),
        getMenuAll().catch(() => ({ total_count: 0 })),
      ]);
      setD1(summary1);
      setD7(summary7);
      setRecent(Array.isArray(orders) ? orders : []);
      setBranches(Array.isArray(branchList) ? branchList : []);
      setMenuTotal(menu?.total_count || 0);
    } catch (err) {
      setError(err?.userMessage || err?.message || 'Could not load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const waConnected = isWaConnected(restaurant);
  const profileDone = !!(restaurant?.brand_name && restaurant?.phone);
  const hasBranch = branches.length > 0;
  const hasMenu = hasBranch && menuTotal > 0;
  const hasCatalog = !!(restaurant?.meta_catalog_id || restaurant?.catalog_id);

  const steps = useMemo(() => ([
    { id: 'wa', label: 'Connect WhatsApp Business', description: 'Link your WhatsApp Business account via Meta', done: waConnected, cta: 'wa-connect' },
    { id: 'profile', label: 'Complete your profile', description: 'Business name, logo, bank account', done: profileDone, onAction: () => navigate('/dashboard/settings') },
    { id: 'branch', label: 'Add your first branch', description: 'GPS coordinates enable location-based ordering', done: hasBranch, onAction: () => navigate('/dashboard/menu') },
    { id: 'menu', label: 'Add menu items', description: 'Items sync to WhatsApp Catalog automatically', done: hasMenu, onAction: () => navigate('/dashboard/menu') },
    { id: 'catalog', label: 'Sync catalog & go live', description: 'Catalog syncs automatically when you add items', done: hasCatalog && hasMenu, onAction: () => navigate('/dashboard/menu') },
  ]), [waConnected, profileDone, hasBranch, hasMenu, hasCatalog, navigate]);

  const handleWaConnected = useCallback(async () => {
    await refetchRestaurant();
    await loadAll();
  }, [refetchRestaurant, loadAll]);

  if (loading || restLoading) {
    return (
      <div id="tab-overview" className="tab on">
        <div className="stats">
          <StatCard label="Today's Orders" value="—" delta="Loading…" />
          <StatCard label="Today's Revenue" value="—" delta="Loading…" />
          <StatCard label="This Week" value="—" delta="Loading…" />
          <StatCard label="In Progress" value="—" delta="Loading…" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div id="tab-overview" className="tab on">
        <div className="card" style={{ padding: '1.2rem', textAlign: 'center' }}>
          <h3 style={{ marginBottom: '.5rem' }}>Could not load overview</h3>
          <p style={{ color: 'var(--dim)', marginBottom: '.8rem' }}>{error}</p>
          <button type="button" className="btn-g btn-sm" onClick={loadAll}>Retry</button>
        </div>
      </div>
    );
  }

  const todayOrders = d1?.summary?.total_orders ?? 0;
  const todayRevenue = `₹${Math.round(d1?.summary?.total_revenue ?? 0)}`;
  const weekOrders = d7?.summary?.total_orders ?? 0;

  return (
    <div id="tab-overview" className="tab on">
      <SetupWizard steps={steps} onWaConnected={handleWaConnected} />

      <div className="stats">
        <StatCard label="Today's Orders"  value={todayOrders}  delta="All statuses" />
        <StatCard label="Today's Revenue" value={todayRevenue} delta="Delivered only" />
        <StatCard label="This Week"       value={weekOrders}   delta="Total orders" />
        <StatCard label="In Progress"     value="—"            delta="Active orders" />
      </div>

      <div className="card">
        <div className="ch">
          <h3>Recent Orders</h3>
          <button type="button" className="btn-g btn-sm" onClick={() => navigate('/dashboard/orders')}>
            View All →
          </button>
        </div>
        {recent.length === 0 ? (
          <div id="recent-body">
            <div className="empty">
              <div className="ei">📋</div>
              <h3>No orders yet</h3>
              <p>Complete your setup to start receiving orders</p>
            </div>
          </div>
        ) : (
          <div id="recent-body">
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r._id || r.order_number}>
                      <td><span className="mono">{r.order_number}</span></td>
                      <td>{customerLabel(r)}</td>
                      <td>₹{r.total_rs}</td>
                      <td>{formatOrderStatus(r.status)}</td>
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
