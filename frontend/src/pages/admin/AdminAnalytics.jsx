import { useCallback, useEffect, useMemo, useState } from 'react';
import StatCard from '../../components/StatCard.jsx';
import ChartCanvas from '../../components/dashboard/ChartCanvas.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import {
  getAnalyticsCities,
  getAnalyticsAreas,
  getAnalyticsOverview,
  getAnalyticsTimeseries,
  getAnalyticsByStatus,
  getAnalyticsByHour,
  getAnalyticsByDay,
  getAnalyticsGeographicCities,
  getAnalyticsRestaurantRanking,
  getAnalyticsCustomerSegments,
  getAnalyticsDeliveryPerformance,
  getAnalyticsCustomersOverview,
  getAnalyticsFunnel,
} from '../../api/admin.js';

// Mirrors admin.html loadAnalyticsDashboard + sub-loaders (5004-5236).
// Chart.js configs match legacy exactly via ChartCanvas (Phase 2g).

const PERIODS = [7, 30, 90, 365];

const STATUS_COLORS = {
  DELIVERED: 'var(--gb-wa-500)', CONFIRMED: '#3b82f6', PREPARING: '#f59e0b',
  PACKED: '#8b5cf6', DISPATCHED: '#06b6d4', CANCELLED: 'var(--gb-red-500)',
  PENDING_PAYMENT: 'var(--gb-slate-400)', PAYMENT_FAILED: '#ef4444',
  EXPIRED: '#78716c', PAID: '#22c55e',
};

const SEGMENT_COLORS = {
  new: '#3b82f6', active: 'var(--gb-wa-500)', at_risk: '#f59e0b',
  lapsed: '#f97316', lost: 'var(--gb-red-500)',
};

const FUNNEL_COLORS = ['var(--gb-slate-400)', '#3b82f6', '#8b5cf6', 'var(--gb-amber-500)', '#0891b2', 'var(--gb-wa-500)'];

function fmtRs(n) {
  const v = parseFloat(n) || 0;
  if (v >= 1e7) return '₹' + (v / 1e7).toFixed(1) + 'Cr';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
  if (v >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
  return '₹' + v.toFixed(0);
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function agoISO(days) {
  return new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
}

function buildParams({ from, to, city, area }) {
  const p = {};
  if (from) p.from = new Date(from).toISOString();
  if (to) p.to = new Date(to + 'T23:59:59').toISOString();
  if (city) p.city = city;
  if (area) p.area = area;
  return p;
}

function ChangePill({ value }) {
  if (value == null || value === 0) return null;
  const pos = value >= 0;
  return (
    <span style={{ color: pos ? 'var(--gb-wa-500)' : 'var(--gb-red-500)' }}>
      {' '}{pos ? '▲' : '▼'} {Math.abs(value)}%
    </span>
  );
}

export default function AdminAnalytics() {
  const [periodDays, setPeriodDays] = useState(7);
  const [from, setFrom] = useState(agoISO(7));
  const [to, setTo] = useState(todayISO());
  const [cities, setCities] = useState([]);
  const [areas, setAreas] = useState([]);
  const [city, setCity] = useState('');
  const [area, setArea] = useState('');

  useEffect(() => {
    getAnalyticsCities().then((list) => {
      setCities(Array.isArray(list) ? list : []);
    }).catch(() => setCities([]));
  }, []);

  useEffect(() => {
    if (!city) { setAreas([]); setArea(''); return; }
    getAnalyticsAreas(city).then((list) => {
      setAreas(Array.isArray(list) ? list : []);
    }).catch(() => setAreas([]));
  }, [city]);

  const setPeriod = (days) => {
    setPeriodDays(days);
    setFrom(agoISO(days));
    setTo(todayISO());
  };

  const resetFilters = () => {
    setCity('');
    setAreas([]);
    setArea('');
    setPeriod(7);
  };

  const params = useMemo(() => buildParams({ from, to, city, area }), [from, to, city, area]);

  return (
    <div id="pg-analytics">
      <div style={{
        display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'end',
        marginBottom: '1.2rem', padding: '.75rem 1rem',
        background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 8,
      }}>
        <div>
          <label style={filterLbl}>Period</label>
          <div style={{ display: 'flex', gap: '.3rem' }}>
            {PERIODS.map((d) => (
              <button
                key={d}
                type="button"
                className={periodDays === d ? 'btn-p btn-sm' : 'btn-g btn-sm'}
                onClick={() => setPeriod(d)}
              >
                {d === 365 ? '1Y' : `${d}D`}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label style={filterLbl}>From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={input} />
        </div>
        <div>
          <label style={filterLbl}>To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={input} />
        </div>
        <div>
          <label style={filterLbl}>City</label>
          <select value={city} onChange={(e) => { setCity(e.target.value); setArea(''); }} style={input}>
            <option value="">All Cities</option>
            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label style={filterLbl}>Area</label>
          <select value={area} onChange={(e) => setArea(e.target.value)} style={input} disabled={!city}>
            <option value="">All Areas</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <button type="button" className="btn-g btn-sm" onClick={resetFilters} style={{ marginLeft: 'auto' }}>
          Reset
        </button>
      </div>

      <OverviewKpis params={params} />

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1rem', marginBottom: '1.2rem' }}>
        <TimeseriesCard params={params} />
        <StatusCard params={params} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.2rem' }}>
        <ByHourCard params={params} />
        <ByDayCard params={params} />
      </div>

      <CitiesCard params={params} onCityClick={(c) => { setCity(c); setArea(''); }} />

      <RestaurantRankingCard params={params} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.2rem' }}>
        <SegmentsCard />
        <DeliveryCard params={params} />
      </div>

      <TopCustomersCard params={params} />

      <FunnelCard />
    </div>
  );
}

function OverviewKpis({ params }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await getAnalyticsOverview(params);
      setD(res);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Overview failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  if (err) return <div style={{ marginBottom: '1.2rem' }}><SectionError message={err} onRetry={load} /></div>;

  const chg = d?.change || {};

  return (
    <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: '1.2rem' }}>
      <StatCard
        label="Total Orders"
        value={d ? d.order_count : '—'}
        delta={chg.order_count != null ? <ChangePill value={chg.order_count} /> : ''}
      />
      <StatCard
        label="GMV"
        value={d ? fmtRs(d.gmv) : '—'}
        delta={chg.gmv != null ? <ChangePill value={chg.gmv} /> : ''}
      />
      <StatCard label="Avg Order Value"  value={d ? fmtRs(d.avg_order_value) : '—'} />
      <StatCard label="Customers"        value={d ? d.customer_count : '—'} />
      <StatCard label="Restaurants"      value={d ? d.active_restaurants : '—'} />
      <StatCard label="Completion"       value={d ? `${d.completion_rate}%` : '—'} />
      <StatCard label="Repeat Rate"      value={d ? `${d.repeat_rate}%` : '—'} />
      <StatCard label="Platform Revenue" value={d ? fmtRs(d.platform_revenue) : '—'} />
    </div>
  );
}

function TimeseriesCard({ params }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await getAnalyticsTimeseries(params);
      setData(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ padding: '1rem' }}>
      <h3 style={{ fontSize: '.85rem', marginBottom: '.6rem' }}>Order Volume & GMV</h3>
      {err ? <SectionError message={err} onRetry={load} /> : !data ? (
        <div style={{ color: 'var(--dim)' }}>Loading…</div>
      ) : (
        <ChartCanvas
          type="bar"
          height={200}
          data={{
            labels: data.map((d) => d.date),
            datasets: [
              { label: 'Orders', data: data.map((d) => d.order_count), backgroundColor: 'rgba(79,70,229,.6)', order: 2, yAxisID: 'y' },
              { label: 'GMV', data: data.map((d) => d.gmv), borderColor: 'var(--gb-wa-500)', type: 'line', tension: .3, pointRadius: 2, order: 1, yAxisID: 'y1' },
            ],
          }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } },
            scales: {
              y: { position: 'left', beginAtZero: true },
              y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } },
              x: { ticks: { font: { size: 10 }, maxTicksLimit: 15 } },
            },
          }}
        />
      )}
    </div>
  );
}

function StatusCard({ params }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await getAnalyticsByStatus(params);
      setData(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ padding: '1rem' }}>
      <h3 style={{ fontSize: '.85rem', marginBottom: '.6rem' }}>Order Status</h3>
      {err ? <SectionError message={err} onRetry={load} /> : !data ? (
        <div style={{ color: 'var(--dim)' }}>Loading…</div>
      ) : (
        <ChartCanvas
          type="doughnut"
          height={200}
          data={{
            labels: data.map((d) => d.status),
            datasets: [{
              data: data.map((d) => d.count),
              backgroundColor: data.map((d) => STATUS_COLORS[d.status] || 'var(--gb-slate-400)'),
            }],
          }}
          options={{
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } } },
          }}
        />
      )}
    </div>
  );
}

function ByHourCard({ params }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await getAnalyticsByHour(params);
      setData(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ padding: '1rem' }}>
      <h3 style={{ fontSize: '.85rem', marginBottom: '.6rem' }}>Orders by Hour</h3>
      {err ? <SectionError message={err} onRetry={load} /> : !data ? (
        <div style={{ color: 'var(--dim)' }}>Loading…</div>
      ) : (
        <ChartCanvas
          type="bar"
          height={180}
          data={{
            labels: data.map((d) => `${d.hour}:00`),
            datasets: [{ label: 'Orders', data: data.map((d) => d.count), backgroundColor: 'rgba(79,70,229,.5)' }],
          }}
          options={{
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { ticks: { font: { size: 10 } } } },
          }}
        />
      )}
    </div>
  );
}

function ByDayCard({ params }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await getAnalyticsByDay(params);
      setData(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ padding: '1rem' }}>
      <h3 style={{ fontSize: '.85rem', marginBottom: '.6rem' }}>Orders by Day</h3>
      {err ? <SectionError message={err} onRetry={load} /> : !data ? (
        <div style={{ color: 'var(--dim)' }}>Loading…</div>
      ) : (
        <ChartCanvas
          type="bar"
          height={180}
          data={{
            labels: data.map((d) => d.day),
            datasets: [{ label: 'Orders', data: data.map((d) => d.count), backgroundColor: 'rgba(22,163,74,.5)' }],
          }}
          options={{
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
          }}
        />
      )}
    </div>
  );
}

function CitiesCard({ params, onCityClick }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await getAnalyticsGeographicCities(params);
      setRows(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch"><h3>City Performance</h3></div>
      {err ? <div className="cb"><SectionError message={err} onRetry={load} /></div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr style={trHead}>
                <th style={th}>City</th>
                <th style={th}>Orders</th>
                <th style={th}>GMV</th>
                <th style={th}>Customers</th>
                <th style={th}>Restaurants</th>
                <th style={th}>AOV</th>
              </tr>
            </thead>
            <tbody>
              {!rows ? (
                <tr><td colSpan={6} style={emptyCell}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} style={emptyCell}>No data</td></tr>
              ) : rows.map((d, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--rim)' }}>
                  <td style={td}>
                    <button
                      type="button"
                      onClick={() => onCityClick(d.city || '')}
                      style={{
                        background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
                        color: 'var(--acc)', fontWeight: 600,
                      }}
                    >
                      {d.city || '—'}
                    </button>
                  </td>
                  <td style={td}>{d.order_count}</td>
                  <td style={td}>{fmtRs(d.gmv)}</td>
                  <td style={td}>{d.customer_count}</td>
                  <td style={td}>{d.restaurant_count}</td>
                  <td style={td}>{fmtRs(d.avg_order_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RestaurantRankingCard({ params }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await getAnalyticsRestaurantRanking(params);
      setRows(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch"><h3>Restaurant Ranking</h3></div>
      {err ? <div className="cb"><SectionError message={err} onRetry={load} /></div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr style={trHead}>
                <th style={th}>#</th>
                <th style={th}>Restaurant</th>
                <th style={th}>City</th>
                <th style={th}>Orders</th>
                <th style={th}>GMV</th>
                <th style={th}>AOV</th>
                <th style={th}>Customers</th>
              </tr>
            </thead>
            <tbody>
              {!rows ? (
                <tr><td colSpan={7} style={emptyCell}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} style={emptyCell}>No data</td></tr>
              ) : rows.map((d, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--rim)' }}>
                  <td style={{ ...td, fontWeight: 600 }}>{i + 1}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{d.name || '—'}</td>
                  <td style={{ ...td, color: 'var(--dim)' }}>{d.city || '—'}</td>
                  <td style={td}>{d.order_count}</td>
                  <td style={{ ...td, fontWeight: 600, color: 'var(--gb-wa-500)' }}>{fmtRs(d.gmv)}</td>
                  <td style={td}>{fmtRs(d.avg_order_value)}</td>
                  <td style={td}>{d.customer_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SegmentsCard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await getAnalyticsCustomerSegments();
      setData(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ padding: '1rem' }}>
      <h3 style={{ fontSize: '.85rem', marginBottom: '.6rem' }}>Customer Segments</h3>
      {err ? <SectionError message={err} onRetry={load} /> : !data ? (
        <div style={{ color: 'var(--dim)' }}>Loading…</div>
      ) : (
        <ChartCanvas
          type="doughnut"
          height={200}
          data={{
            labels: data.map((d) => d.segment),
            datasets: [{
              data: data.map((d) => d.count),
              backgroundColor: data.map((d) => SEGMENT_COLORS[d.segment] || 'var(--gb-slate-400)'),
            }],
          }}
          options={{
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } } },
          }}
        />
      )}
    </div>
  );
}

function DeliveryCard({ params }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await getAnalyticsDeliveryPerformance(params);
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  const hist = data?.histogram || [];

  return (
    <div className="card" style={{ padding: '1rem' }}>
      <h3 style={{ fontSize: '.85rem', marginBottom: '.6rem' }}>Delivery Time Distribution</h3>
      {err ? <SectionError message={err} onRetry={load} /> : !data ? (
        <div style={{ color: 'var(--dim)' }}>Loading…</div>
      ) : (
        <ChartCanvas
          type="bar"
          height={200}
          data={{
            labels: hist.map((h) => h.bucket),
            datasets: [{ label: 'Deliveries', data: hist.map((h) => h.count), backgroundColor: 'rgba(6,182,212,.5)' }],
          }}
          options={{
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              title: { display: true, text: `Avg: ${data.avg_delivery_mins || '—'} min`, font: { size: 11 } },
            },
          }}
        />
      )}
    </div>
  );
}

function TopCustomersCard({ params }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await getAnalyticsCustomersOverview(params);
      setRows(d?.top_by_spend || []);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card">
      <div className="ch"><h3>Top Customers by Spend</h3></div>
      {err ? <div className="cb"><SectionError message={err} onRetry={load} /></div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr style={trHead}>
                <th style={th}>#</th>
                <th style={th}>Customer</th>
                <th style={th}>Phone</th>
                <th style={th}>Orders</th>
                <th style={th}>Total Spent</th>
              </tr>
            </thead>
            <tbody>
              {!rows ? (
                <tr><td colSpan={5} style={emptyCell}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={5} style={emptyCell}>No data</td></tr>
              ) : rows.map((c, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--rim)' }}>
                  <td style={{ ...td, fontWeight: 600 }}>{i + 1}</td>
                  <td style={td}>{c.name || '—'}</td>
                  <td style={{ ...td, fontSize: '.78rem', color: 'var(--dim)' }} className="mono">{c.phone || '—'}</td>
                  <td style={td}>{c.order_count}</td>
                  <td style={{ ...td, fontWeight: 600, color: 'var(--gb-wa-500)' }}>{fmtRs(c.total_spent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FunnelCard() {
  const [funnel, setFunnel] = useState(null);
  const [restData, setRestData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const [platform, perRest] = await Promise.all([
        getAnalyticsFunnel(),
        getAnalyticsFunnel({ group_by: 'restaurant' }),
      ]);
      setFunnel(Array.isArray(platform?.funnel) ? platform.funnel : []);
      const arr = Array.isArray(perRest?.data) ? [...perRest.data] : [];
      arr.sort((a, b) => (a.completion_rate || 0) - (b.completion_rate || 0));
      setRestData(arr);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Funnel failed');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const topDropoff = (r) => {
    const stages = ['dropped_at_address', 'dropped_at_browsing', 'dropped_at_cart', 'dropped_at_payment'];
    const labels = { dropped_at_address: 'Address', dropped_at_browsing: 'Menu', dropped_at_cart: 'Cart', dropped_at_payment: 'Payment' };
    let topStage = '';
    let topCount = 0;
    stages.forEach((s) => {
      if ((r[s] || 0) > topCount) { topCount = r[s]; topStage = labels[s] || s; }
    });
    return topCount ? `${topStage} (${topCount})` : '—';
  };

  return (
    <div className="card" style={{ marginTop: '1.2rem' }}>
      <div className="ch"><h3>Platform Conversion Funnel</h3></div>
      <div className="cb">
        {err ? <SectionError message={err} onRetry={load} /> : (
          <>
            <div style={{ marginBottom: '1rem' }}>
              {!funnel ? (
                <div style={{ color: 'var(--dim)' }}>Loading…</div>
              ) : funnel.length === 0 ? (
                <div style={{ color: 'var(--dim)' }}>No data</div>
              ) : funnel.map((f, i) => {
                const pct = Math.max(Number(f.pct) || 0, 2);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.4rem' }}>
                    <span style={{ width: 110, fontSize: '.78rem', fontWeight: 500, color: 'var(--dim)', textAlign: 'right' }}>
                      {f.stage}
                    </span>
                    <div style={{ flex: 1, background: 'var(--gb-slate-100)', borderRadius: 6, overflow: 'hidden', height: 28, position: 'relative' }}>
                      <div style={{
                        width: `${pct}%`, height: '100%',
                        background: FUNNEL_COLORS[i] || 'var(--gb-slate-500)', borderRadius: 6,
                        transition: 'width .4s',
                      }} />
                      <span style={{
                        position: 'absolute', left: '.6rem', top: '50%',
                        transform: 'translateY(-50%)', fontSize: '.72rem', fontWeight: 600,
                        color: pct > 15 ? 'var(--gb-neutral-0)' : 'var(--gb-slate-800)',
                      }}>
                        {f.count} ({f.pct}%)
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            <h3 style={{ fontSize: '.88rem', margin: '1.2rem 0 .6rem' }}>Restaurant Comparison</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr style={trHead}>
                    <th style={th}>Restaurant</th>
                    <th style={th}>Initiated</th>
                    <th style={th}>Completed</th>
                    <th style={th}>Rate</th>
                    <th style={th}>Top Drop-off</th>
                  </tr>
                </thead>
                <tbody>
                  {!restData ? (
                    <tr><td colSpan={5} style={emptyCell}>Loading…</td></tr>
                  ) : restData.length === 0 ? (
                    <tr><td colSpan={5} style={emptyCell}>No data</td></tr>
                  ) : restData.map((r, i) => {
                    const rate = r.completion_rate || 0;
                    const color = rate >= 50 ? 'var(--gb-wa-500)' : rate >= 25 ? 'var(--gb-amber-500)' : 'var(--gb-red-500)';
                    return (
                      <tr key={i} style={{ borderBottom: '1px solid var(--rim)' }}>
                        <td style={{ ...td, fontWeight: 500 }}>{r.restaurant_name || '—'}</td>
                        <td style={td}>{r.total_initiated || 0}</td>
                        <td style={td}>{r.completed || 0}</td>
                        <td style={{ ...td, fontWeight: 700, color }}>{rate}%</td>
                        <td style={{ ...td, fontSize: '.8rem', color: 'var(--dim)' }}>{topDropoff(r)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' };
const trHead = { background: 'var(--ink)', borderBottom: '1px solid var(--rim)' };
const th = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td = { padding: '.55rem .7rem', verticalAlign: 'top' };
const emptyCell = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.28rem .5rem', fontSize: '.78rem' };
const filterLbl = { fontSize: '.68rem', color: 'var(--dim)', display: 'block', marginBottom: '.2rem' };
