import { useCallback, useEffect, useMemo, useState } from 'react';
import StatCard from '../../components/StatCard.jsx';
import ChartCanvas from '../../components/dashboard/ChartCanvas.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import {
  getLogisticsAnalytics,
  getAdminRestaurants,
  getAdminBranches,
} from '../../api/admin.js';

// Mirrors admin.html logistics analytics (5661-5840): restaurant→branch
// cascade + LSP filter, 15 KPI cards, "Daily Delivered by LSP" grouped bar,
// "Daily by Status" stacked bar. Defaults to today (IST).

const STATUS_COLORS = {
  DELIVERED: '#16a34a', CONFIRMED: '#3b82f6', PREPARING: '#f59e0b', PACKED: '#8b5cf6',
  DISPATCHED: '#06b6d4', CANCELLED: '#dc2626', PENDING_PAYMENT: '#94a3b8',
  PAYMENT_FAILED: '#ef4444', EXPIRED: '#78716c', PAID: '#22c55e',
  RTO_IN_PROGRESS: '#f97316', RTO_COMPLETE: '#64748b',
};

const LSP_PALETTE = ['#4f46e5', '#16a34a', '#d97706', '#0891b2', '#dc2626', '#7c3aed', '#14b8a6'];

function todayIST() {
  const now = new Date();
  const offsetMs = (330 - now.getTimezoneOffset()) * 60000;
  const ist = new Date(now.getTime() + offsetMs);
  return ist.toISOString().slice(0, 10);
}

function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-IN'); }
function fmtDec(n) { return n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 }); }
function fmtRs(n) { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

export default function AdminLogistics() {
  const today = todayIST();
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [rid, setRid] = useState('');
  const [bid, setBid] = useState('');
  const [lsp, setLsp] = useState('');

  const [restaurants, setRestaurants] = useState([]);
  const [branches, setBranches] = useState([]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await getAdminRestaurants();
        const items = Array.isArray(list) ? list : (list?.items || list?.restaurants || []);
        setRestaurants(items.map((r) => ({ id: r.id || r._id, name: r.business_name || r.name || r.id || r._id })));
      } catch { /* non-fatal */ }
    })();
  }, []);

  useEffect(() => {
    setBid('');
    if (!rid) { setBranches([]); return; }
    (async () => {
      try {
        const list = await getAdminBranches(rid);
        setBranches((list || []).map((b) => ({ id: b.id, name: b.name || b.branch_slug || b.id })));
      } catch {
        setBranches([]);
      }
    })();
  }, [rid]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = {};
    if (fromDate) params.from = fromDate;
    if (toDate) params.to = toDate;
    if (rid) params.restaurantId = rid;
    if (bid) params.branchId = bid;
    if (lsp.trim()) params.lsp = lsp.trim();
    try {
      const d = await getLogisticsAnalytics(params);
      setData(d);
      setErr(null);
    } catch (e) {
      setData(null);
      setErr(e?.response?.data?.error || e?.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, rid, bid, lsp]);

  useEffect(() => { load(); }, [load]);

  const applyToday = () => {
    setFromDate(today);
    setToDate(today);
  };

  const s = data?.summary || {};

  const lspChart = useMemo(() => {
    const rows = data?.dailyByLsp || [];
    if (!rows.length) return null;
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const lsps = [...new Set(rows.map((r) => r.lsp))].sort();
    const datasets = lsps.map((l, i) => {
      const color = LSP_PALETTE[i % LSP_PALETTE.length];
      return {
        label: l,
        data: dates.map((date) => {
          const row = rows.find((r) => r.date === date && r.lsp === l);
          return row ? row.count : 0;
        }),
        backgroundColor: color + 'cc',
        borderColor: color,
        borderWidth: 1,
        borderRadius: 3,
      };
    });
    return { labels: dates, datasets };
  }, [data]);

  const statusChart = useMemo(() => {
    const rows = data?.dailyByStatus || [];
    if (!rows.length) return null;
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const statuses = [...new Set(rows.map((r) => r.status))];
    const datasets = statuses.map((st) => {
      const color = STATUS_COLORS[st] || '#94a3b8';
      return {
        label: st,
        data: dates.map((date) => {
          const row = rows.find((r) => r.date === date && r.status === st);
          return row ? row.count : 0;
        }),
        backgroundColor: color + 'cc',
        borderColor: color,
        borderWidth: 1,
        borderRadius: 3,
      };
    });
    return { labels: dates, datasets };
  }, [data]);

  return (
    <div id="pg-logistics">
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', padding: '.75rem 1rem', alignItems: 'flex-end' }}>
          <div>
            <label style={lbl}>From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={input} />
          </div>
          <div>
            <label style={lbl}>To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={input} />
          </div>
          <div>
            <label style={lbl}>Restaurant</label>
            <select value={rid} onChange={(e) => setRid(e.target.value)} style={{ ...input, minWidth: 180 }}>
              <option value="">All restaurants</option>
              {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Branch</label>
            <select value={bid} onChange={(e) => setBid(e.target.value)} style={{ ...input, minWidth: 160 }} disabled={!rid}>
              <option value="">All branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>LSP</label>
            <input
              value={lsp}
              onChange={(e) => setLsp(e.target.value)}
              placeholder="e.g. Prorouting"
              style={{ ...input, width: 140 }}
            />
          </div>
          <button type="button" className="btn-p btn-sm" onClick={load} disabled={loading}>Apply</button>
          <button type="button" className="btn-g btn-sm" onClick={applyToday}>Today</button>
        </div>
      </div>

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
            <StatCard label="Delivered Orders" value={loading ? '…' : fmtNum(s.deliveredOrders)} />
            <StatCard label="Cancelled By Client" value={loading ? '…' : fmtNum(s.cancelledByClient)} />
            <StatCard label="Cancelled By System" value={loading ? '…' : fmtNum(s.cancelledBySystem)} />
            <StatCard label="Avg Distance (km)" value={loading ? '…' : fmtDec(s.avgDistanceKm)} />
            <StatCard label="Avg LSP Fee" value={loading ? '…' : fmtRs(s.avgLspFee)} />
            <StatCard label="Avg Total Fee" value={loading ? '…' : fmtRs(s.avgTotalFee)} />
            <StatCard label="Total Fee With GST" value={loading ? '…' : fmtRs(s.totalFeeWithGst)} />
            <StatCard label="COD Collected" value={loading ? '…' : fmtRs(s.codCollected)} />
            <StatCard label="Avg Agent Assign (min)" value={loading ? '…' : fmtDec(s.avgAgentAssignMinutes)} />
            <StatCard label="Avg Reach Pickup (min)" value={loading ? '…' : fmtDec(s.avgReachPickupMinutes)} />
            <StatCard label="Avg Reach Delivery (min)" value={loading ? '…' : fmtDec(s.avgReachDeliveryMinutes)} />
            <StatCard label="Avg Delivery Time (min)" value={loading ? '…' : fmtDec(s.avgDeliveryTotalMinutes)} />
            <StatCard label="Avg Pickup Wait (min)" value={loading ? '…' : fmtDec(s.avgPickupWaitMinutes)} />
            <StatCard label="Pending Issues" value={loading ? '…' : fmtNum(s.pendingIssues)} />
            <StatCard label="Liability Accepted" value={loading ? '…' : fmtNum(s.liabilityAccepted)} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1rem' }}>
            <div className="card">
              <div className="ch"><h3 style={{ margin: 0, fontSize: '.9rem' }}>Daily Delivered by LSP</h3></div>
              <div className="cb">
                {loading ? (
                  <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)' }}>Loading…</div>
                ) : !lspChart ? (
                  <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)' }}>No delivery data yet</div>
                ) : (
                  <ChartCanvas
                    type="bar"
                    data={lspChart}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } } },
                      scales: { x: { ticks: { font: { size: 10 } } }, y: { beginAtZero: true, ticks: { precision: 0 } } },
                    }}
                    height={260}
                  />
                )}
              </div>
            </div>

            <div className="card">
              <div className="ch"><h3 style={{ margin: 0, fontSize: '.9rem' }}>Daily by Status</h3></div>
              <div className="cb">
                {loading ? (
                  <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)' }}>Loading…</div>
                ) : !statusChart ? (
                  <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)' }}>No order data for this period</div>
                ) : (
                  <ChartCanvas
                    type="bar"
                    data={statusChart}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } } },
                      scales: {
                        x: { stacked: true, ticks: { font: { size: 10 } } },
                        y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
                      },
                    }}
                    height={260}
                  />
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const input = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.3rem .5rem', fontSize: '.78rem' };
const lbl = { fontSize: '.68rem', color: 'var(--dim)', display: 'block', marginBottom: '.2rem' };
