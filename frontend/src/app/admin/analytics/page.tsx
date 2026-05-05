'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { ChartData, ChartOptions, ChartDataset } from 'chart.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import StatCard from '../../../components/StatCard';
import ChartCanvas from '../../../components/restaurant/ChartCanvas';
import SectionError from '../../../components/restaurant/analytics/SectionError';
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
} from '../../../api/admin';

const PERIODS = [7, 30, 90, 365];

const STATUS_COLORS: Record<string, string> = {
  DELIVERED: 'var(--gb-wa-500)', CONFIRMED: '#3b82f6', PREPARING: '#f59e0b',
  PACKED: '#8b5cf6', DISPATCHED: '#06b6d4', CANCELLED: 'var(--gb-red-500)',
  PENDING_PAYMENT: 'var(--gb-slate-400)', PAYMENT_FAILED: '#ef4444',
  EXPIRED: '#78716c', PAID: '#22c55e',
};

const SEGMENT_COLORS: Record<string, string> = {
  new: '#3b82f6', active: 'var(--gb-wa-500)', at_risk: '#f59e0b',
  lapsed: '#f97316', lost: 'var(--gb-red-500)',
};

const FUNNEL_COLORS = ['var(--gb-slate-400)', '#3b82f6', '#8b5cf6', 'var(--gb-amber-500)', '#0891b2', 'var(--gb-wa-500)'];

interface AnalyticsParams {
  from?: string;
  to?: string;
  city?: string;
  area?: string;
}

interface OverviewChange {
  order_count?: number;
  gmv?: number;
}

interface OverviewData {
  order_count?: number;
  gmv?: number | string;
  avg_order_value?: number | string;
  customer_count?: number;
  active_restaurants?: number;
  completion_rate?: number;
  repeat_rate?: number;
  platform_revenue?: number | string;
  change?: OverviewChange;
}

interface TimeseriesRow { date: string; order_count: number; gmv: number }
interface ByStatusRow { status: string; count: number }
interface ByHourRow { hour: number; count: number }
interface ByDayRow { day: string; count: number }
interface CityRow { city?: string; order_count?: number; gmv?: number; customer_count?: number; restaurant_count?: number; avg_order_value?: number }
interface RestaurantRankRow { name?: string; city?: string; order_count?: number; gmv?: number; avg_order_value?: number; customer_count?: number }
interface SegmentRow { segment: string; count: number }
interface DeliveryHistRow { bucket: string; count: number }
interface DeliveryPerf { histogram?: DeliveryHistRow[]; avg_delivery_mins?: number }
interface TopCustomerRow { name?: string; phone?: string; order_count?: number; total_spent?: number | string }
interface CustomersOverview { top_by_spend?: TopCustomerRow[] }
interface FunnelStep { stage: string; count: number; pct: number | string }
interface FunnelResponse { funnel?: FunnelStep[] }
interface FunnelRestRow { restaurant_name?: string; total_initiated?: number; completed?: number; completion_rate?: number; dropped_at_address?: number; dropped_at_browsing?: number; dropped_at_cart?: number; dropped_at_payment?: number; [key: string]: unknown }
interface FunnelByRestResponse { data?: FunnelRestRow[] }

function fmtRs(n: number | string | null | undefined): string {
  const v = parseFloat(String(n)) || 0;
  if (v >= 1e7) return '₹' + (v / 1e7).toFixed(1) + 'Cr';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
  if (v >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
  return '₹' + v.toFixed(0);
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0] || '';
}

function agoISO(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().split('T')[0] || '';
}

function buildParams({ from, to, city, area }: AnalyticsParams): Record<string, string> {
  const p: Record<string, string> = {};
  if (from) p.from = new Date(from).toISOString();
  if (to) p.to = new Date(to + 'T23:59:59').toISOString();
  if (city) p.city = city;
  if (area) p.area = area;
  return p;
}

interface ChangePillProps { value?: number | null }

function ChangePill({ value }: ChangePillProps): ReactNode {
  if (value == null || value === 0) return null;
  const pos = value >= 0;
  return (
    <span style={{ color: pos ? 'var(--gb-wa-500)' : 'var(--gb-red-500)' }}>
      {' '}{pos ? '▲' : '▼'} {Math.abs(value)}%
    </span>
  );
}

const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' };
const trHead: CSSProperties = { background: 'var(--ink)', borderBottom: '1px solid var(--rim)' };
const th: CSSProperties = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.55rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input: CSSProperties = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.28rem .5rem', fontSize: '.78rem' };
const filterLbl: CSSProperties = { fontSize: '.68rem', color: 'var(--dim)', display: 'block', marginBottom: '.2rem' };

export default function AdminAnalyticsPage() {
  const [periodDays, setPeriodDays] = useState<number>(7);
  const [from, setFrom] = useState<string>(agoISO(7));
  const [to, setTo] = useState<string>(todayISO());
  const [cities, setCities] = useState<string[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [city, setCity] = useState<string>('');
  const [area, setArea] = useState<string>('');

  useEffect(() => {
    (getAnalyticsCities() as Promise<string[] | null>).then((list) => {
      setCities(Array.isArray(list) ? list : []);
    }).catch(() => setCities([]));
  }, []);

  useEffect(() => {
    if (!city) { setAreas([]); setArea(''); return; }
    (getAnalyticsAreas(city) as Promise<string[] | null>).then((list) => {
      setAreas(Array.isArray(list) ? list : []);
    }).catch(() => setAreas([]));
  }, [city]);

  const setPeriod = (days: number) => {
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

interface ParamsProps { params: Record<string, string> }

function OverviewKpis({ params }: ParamsProps): ReactNode {
  const [d, setD] = useState<OverviewData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await getAnalyticsOverview(params)) as OverviewData | null;
      setD(res);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Overview failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  if (err) return <div style={{ marginBottom: '1.2rem' }}><SectionError message={err} onRetry={load} /></div>;

  const chg = d?.change || {};

  return (
    <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: '1.2rem' }}>
      <StatCard
        label="Total Orders"
        value={d ? (d.order_count ?? '—') : '—'}
        delta={chg.order_count != null ? <ChangePill value={chg.order_count} /> : ''}
      />
      <StatCard
        label="GMV"
        value={d ? fmtRs(d.gmv) : '—'}
        delta={chg.gmv != null ? <ChangePill value={chg.gmv} /> : ''}
      />
      <StatCard label="Avg Order Value"  value={d ? fmtRs(d.avg_order_value) : '—'} />
      <StatCard label="Customers"        value={d ? (d.customer_count ?? '—') : '—'} />
      <StatCard label="Restaurants"      value={d ? (d.active_restaurants ?? '—') : '—'} />
      <StatCard label="Completion"       value={d ? `${d.completion_rate ?? 0}%` : '—'} />
      <StatCard label="Repeat Rate"      value={d ? `${d.repeat_rate ?? 0}%` : '—'} />
      <StatCard label="Platform Revenue" value={d ? fmtRs(d.platform_revenue) : '—'} />
    </div>
  );
}

function TimeseriesCard({ params }: ParamsProps): ReactNode {
  const [data, setData] = useState<TimeseriesRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await getAnalyticsTimeseries(params)) as TimeseriesRow[] | null;
      setData(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed');
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ padding: '1rem' }}>
      <h3 style={{ fontSize: '.85rem', marginBottom: '.6rem' }}>Order Volume &amp; GMV</h3>
      {err ? <SectionError message={err} onRetry={load} /> : !data ? (
        <div style={{ color: 'var(--dim)' }}>Loading…</div>
      ) : (
        <ChartCanvas
          type="bar"
          height={200}
          data={{
            labels: data.map((d) => d.date),
            datasets: [
              { label: 'Orders', data: data.map((d) => d.order_count), backgroundColor: 'rgba(79,70,229,.6)', order: 2, yAxisID: 'y' } as ChartDataset<'bar'>,
              { label: 'GMV', data: data.map((d) => d.gmv), borderColor: 'var(--gb-wa-500)', type: 'line', tension: .3, pointRadius: 2, order: 1, yAxisID: 'y1' } as unknown as ChartDataset<'bar'>,
            ],
          } satisfies ChartData<'bar'>}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } },
            scales: {
              y: { position: 'left', beginAtZero: true },
              y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } },
              x: { ticks: { font: { size: 10 }, maxTicksLimit: 15 } },
            },
          } satisfies ChartOptions<'bar'>}
        />
      )}
    </div>
  );
}

function StatusCard({ params }: ParamsProps): ReactNode {
  const [data, setData] = useState<ByStatusRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await getAnalyticsByStatus(params)) as ByStatusRow[] | null;
      setData(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed');
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

function ByHourCard({ params }: ParamsProps): ReactNode {
  const [data, setData] = useState<ByHourRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await getAnalyticsByHour(params)) as ByHourRow[] | null;
      setData(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed');
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

function ByDayCard({ params }: ParamsProps): ReactNode {
  const [data, setData] = useState<ByDayRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await getAnalyticsByDay(params)) as ByDayRow[] | null;
      setData(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed');
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

interface CitiesCardProps extends ParamsProps { onCityClick: (c: string) => void }

function CitiesCard({ params, onCityClick }: CitiesCardProps): ReactNode {
  const [rows, setRows] = useState<CityRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await getAnalyticsGeographicCities(params)) as CityRow[] | null;
      setRows(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed');
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

function RestaurantRankingCard({ params }: ParamsProps): ReactNode {
  const [rows, setRows] = useState<RestaurantRankRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await getAnalyticsRestaurantRanking(params)) as RestaurantRankRow[] | null;
      setRows(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed');
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

function SegmentsCard(): ReactNode {
  const [data, setData] = useState<SegmentRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await getAnalyticsCustomerSegments()) as SegmentRow[] | null;
      setData(Array.isArray(d) ? d : []);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed');
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

function DeliveryCard({ params }: ParamsProps): ReactNode {
  const [data, setData] = useState<DeliveryPerf | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await getAnalyticsDeliveryPerformance(params)) as DeliveryPerf | null;
      setData(d);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed');
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

function TopCustomersCard({ params }: ParamsProps): ReactNode {
  const [rows, setRows] = useState<TopCustomerRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await getAnalyticsCustomersOverview(params)) as CustomersOverview | null;
      setRows(d?.top_by_spend || []);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed');
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

function FunnelCard(): ReactNode {
  const [funnel, setFunnel] = useState<FunnelStep[] | null>(null);
  const [restData, setRestData] = useState<FunnelRestRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [platform, perRest] = await Promise.all([
        getAnalyticsFunnel() as Promise<FunnelResponse | null>,
        getAnalyticsFunnel({ group_by: 'restaurant' }) as Promise<FunnelByRestResponse | null>,
      ]);
      setFunnel(Array.isArray(platform?.funnel) ? platform.funnel : []);
      const arr = Array.isArray(perRest?.data) ? [...perRest.data] : [];
      arr.sort((a, b) => (a.completion_rate || 0) - (b.completion_rate || 0));
      setRestData(arr);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Funnel failed');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const topDropoff = (r: FunnelRestRow): string => {
    const stages = ['dropped_at_address', 'dropped_at_browsing', 'dropped_at_cart', 'dropped_at_payment'] as const;
    const labels: Record<string, string> = { dropped_at_address: 'Address', dropped_at_browsing: 'Menu', dropped_at_cart: 'Cart', dropped_at_payment: 'Payment' };
    let topStage = '';
    let topCount = 0;
    stages.forEach((s) => {
      const v = (r[s] as number | undefined) || 0;
      if (v > topCount) { topCount = v; topStage = labels[s] || s; }
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
