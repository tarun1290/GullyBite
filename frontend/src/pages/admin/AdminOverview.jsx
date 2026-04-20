import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import StatCard from '../../components/StatCard.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import {
  getAdminStats,
  getAdminRatingStats,
  getAdminDeliveryStats,
  getAdminAlerts,
  getAdminOrders,
  getAdminLogs,
} from '../../api/admin.js';

// Mirrors admin.html page-overview (349-375) + loadStats/loadOverviewOrders/
// loadOverviewLogs/loadPlatformAlerts (2094-2210). Eight stat cards fed by
// /api/admin/stats + /ratings/stats + /delivery/stats, two quick tables
// (Recent Orders, Recent Logs) and the platform alerts banner.

const SOURCE_BADGE = {
  whatsapp: { bg: 'rgba(37,211,102,.18)', color: '#047857' },
  razorpay: { bg: 'rgba(59,130,246,.18)', color: '#1d4ed8' },
  '3pl':    { bg: 'rgba(245,158,11,.18)', color: '#b45309' },
  catalog:  { bg: 'rgba(139,92,246,.18)', color: '#6d28d9' },
};

function sourceBadge(src) {
  const s = (src || 'other').toLowerCase();
  const cfg = SOURCE_BADGE[s] || { bg: 'rgba(100,116,139,.18)', color: '#334155' };
  return (
    <span style={{
      display: 'inline-block', padding: '.1rem .5rem', borderRadius: 10,
      fontSize: '.72rem', fontWeight: 600, background: cfg.bg, color: cfg.color,
      textTransform: 'uppercase', letterSpacing: '.03em',
    }}>{s}</span>
  );
}

function logStatus(l) {
  if (l.error_message) return <span style={{ color: '#b91c1c', fontSize: '.75rem', fontWeight: 600 }}>Error</span>;
  if (l.processed) return <span style={{ color: '#047857', fontSize: '.75rem', fontWeight: 600 }}>OK</span>;
  return <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>Pending</span>;
}

function orderStatus(s) {
  const st = (s || '').toUpperCase();
  const color = {
    DELIVERED: '#047857', CONFIRMED: '#1d4ed8', PREPARING: '#b45309',
    PACKED: '#6d28d9', DISPATCHED: '#0891b2', CANCELLED: '#b91c1c',
    PAID: '#047857', PENDING_PAYMENT: '#64748b', PAYMENT_FAILED: '#dc2626',
  }[st] || '#334155';
  return <span style={{ color, fontSize: '.75rem', fontWeight: 600 }}>{st || '—'}</span>;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-IN'); }

export default function AdminOverview() {
  const [stats, setStats] = useState(null);
  const [rating, setRating] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, o, l] = await Promise.all([
        getAdminStats(),
        getAdminOrders({ limit: 8 }),
        getAdminLogs({ limit: 8 }),
      ]);
      setStats(s);
      setOrders(o?.orders || []);
      setLogs(l?.logs || []);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed to load overview');
    } finally {
      setLoading(false);
    }
    try { setRating(await getAdminRatingStats()); } catch { /* non-fatal */ }
    try { setDelivery(await getAdminDeliveryStats()); } catch { /* non-fatal */ }
    try { setAlerts((await getAdminAlerts()) || []); } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const s = stats || {};
  const r = rating || {};
  const ds = delivery || {};

  const restTotal = s.restaurants?.total;
  const restActive = s.restaurants?.active;
  const ordTotal = s.orders?.total;
  const ordToday = s.orders?.today;
  const ordPending = s.orders?.pending;
  const ordCancelled = s.orders?.cancelled;
  const revTotal = s.revenue?.total_rs;
  const revWeek = s.revenue?.week_rs;
  const custTotal = s.customers?.total;
  const custToday = s.customers?.today;
  const logsTotal = s.logs?.total;
  const logsUnproc = s.logs?.unprocessed;

  const ratingVal = r.total ? `${r.avg_food} ⭐` : '—';
  const ratingSub = r.total != null ? `${fmtNum(r.total)} reviews` : '';

  const delivTotal = ds.total_today;
  const delivSub = ds.total_today != null
    ? `${fmtNum(ds.active_now)} active · ${ds.avg_delivery_min || 0}m avg · ₹${fmtNum(ds.cost_today_rs)} cost`
    : '';

  return (
    <div id="pg-overview">
      {alerts.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          {alerts.map((a, i) => {
            const crit = a.severity === 'critical';
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: '.7rem',
                padding: '.65rem 1rem',
                background: crit ? '#fef2f2' : '#fffbeb',
                border: `1px solid ${crit ? '#fecaca' : '#fde68a'}`,
                color: crit ? '#dc2626' : '#d97706',
                borderRadius: 8, marginBottom: '.5rem', fontSize: '.84rem',
              }}>
                <span>{crit ? '\u{1F534}' : '\u26A0\uFE0F'}</span>
                <span style={{ fontWeight: 600 }}>{a.title || a.message || 'Alert'}</span>
                {a.detail && <span style={{ color: 'var(--dim)' }}>{a.detail}</span>}
              </div>
            );
          })}
        </div>
      )}

      {err ? (
        <div style={{ marginBottom: '1rem' }}><SectionError message={err} onRetry={load} /></div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: '.6rem',
              marginBottom: '1.2rem',
            }}
          >
            <StatCard label="Restaurants" value={loading ? '…' : fmtNum(restTotal)}
              delta={restActive != null ? `${fmtNum(restActive)} active` : null} />
            <StatCard label="Total Orders" value={loading ? '…' : fmtNum(ordTotal)}
              delta={ordToday != null ? `${fmtNum(ordToday)} today` : null} />
            <StatCard label="Total Revenue"
              value={loading ? '…' : (revTotal != null ? `\u20B9${fmtNum(revTotal)}` : '—')}
              delta={revWeek != null ? `\u20B9${fmtNum(revWeek)} this week` : null} />
            <StatCard label="Customers" value={loading ? '…' : fmtNum(custTotal)}
              delta={custToday != null ? `${fmtNum(custToday)} today` : null} />
            <StatCard label="Webhook Logs" value={loading ? '…' : fmtNum(logsTotal)}
              delta={logsUnproc != null ? `${fmtNum(logsUnproc)} unprocessed` : null} />
            <StatCard label="Pending Orders" value={loading ? '…' : fmtNum(ordPending)}
              delta={ordCancelled != null ? `${fmtNum(ordCancelled)} cancelled` : null} />
            <StatCard label="Avg Rating" value={loading ? '…' : ratingVal} delta={ratingSub || null} />
            <StatCard label="Deliveries Today"
              value={loading ? '…' : (delivTotal != null ? fmtNum(delivTotal) : '—')}
              delta={delivSub || null} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1rem' }}>
            <div className="card">
              <div className="ch" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0, fontSize: '.9rem' }}>Recent Orders</h3>
                <Link to="/admin/orders" className="btn-g btn-sm">View All</Link>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                      <th style={th}>Order</th>
                      <th style={th}>Restaurant</th>
                      <th style={th}>Amount</th>
                      <th style={th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={4} style={emptyCell}>Loading…</td></tr>
                    ) : orders.length === 0 ? (
                      <tr><td colSpan={4} style={emptyCell}>No orders yet</td></tr>
                    ) : orders.map((o) => (
                      <tr key={o.id || o.order_number} style={{ borderTop: '1px solid var(--rim)' }}>
                        <td style={{ ...td, fontFamily: 'monospace' }}>#{o.order_number}</td>
                        <td style={{ ...td, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{o.business_name || '—'}</td>
                        <td style={td}>{o.total_rs != null ? `\u20B9${o.total_rs}` : '—'}</td>
                        <td style={td}>{orderStatus(o.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="ch" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0, fontSize: '.9rem' }}>Recent Logs</h3>
                <Link to="/admin/logs" className="btn-g btn-sm">View All</Link>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                      <th style={th}>Source</th>
                      <th style={th}>Event</th>
                      <th style={th}>Status</th>
                      <th style={th}>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={4} style={emptyCell}>Loading…</td></tr>
                    ) : logs.length === 0 ? (
                      <tr><td colSpan={4} style={emptyCell}>No logs yet</td></tr>
                    ) : logs.map((l) => (
                      <tr key={l.id} style={{ borderTop: '1px solid var(--rim)' }}>
                        <td style={td}>{sourceBadge(l.source)}</td>
                        <td style={{ ...td, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{l.event_type || '—'}</td>
                        <td style={td}>{logStatus(l)}</td>
                        <td style={{ ...td, color: 'var(--dim)' }}>{timeAgo(l.received_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const th = { padding: '.5rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td = { padding: '.5rem .7rem', verticalAlign: 'top' };
const emptyCell = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
