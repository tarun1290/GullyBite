import { useCallback, useMemo, useState } from 'react';
import ChartCanvas from '../ChartCanvas.jsx';
import SectionError from './SectionError.jsx';
import useAnalyticsFetch from './useAnalyticsFetch.js';
import { getAnalyticsOverview, getRevenueAnalytics } from '../../../api/restaurant.js';

// Mirrors anLoadOverview() + anLoadRevenue() in legacy analytics.js:75-132.

const STATUS_COLORS = {
  PENDING_PAYMENT: '#94a3b8',
  PAID: '#2563eb',
  CONFIRMED: '#7c3aed',
  PREPARING: '#d97706',
  PACKED: '#0891b2',
  DISPATCHED: '#4f46e5',
  DELIVERED: '#16a34a',
  CANCELLED: '#dc2626',
};

const GRANULARITY_OPTIONS = [
  ['day', 'Daily'],
  ['week', 'Weekly'],
  ['month', 'Monthly'],
];

function PctChange({ value }) {
  if (value == null) return null;
  const down = value < 0;
  return (
    <span className={`stat-s${down ? ' dn' : ''}`}>
      {down ? '↓' : '↑'} {Math.abs(value)}% vs prev period
    </span>
  );
}

function StatusBreakdown({ breakdown }) {
  const entries = breakdown ? Object.entries(breakdown) : [];
  if (!entries.length) {
    return <span style={{ color: 'var(--dim)', fontSize: '.82rem' }}>No data</span>;
  }
  return entries.map(([s, c]) => {
    const color = STATUS_COLORS[s] || '#94a3b8';
    return (
      <span
        key={s}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '.35rem',
          padding: '.3rem .7rem',
          borderRadius: 100,
          fontSize: '.75rem',
          fontWeight: 500,
          background: `${color}15`,
          color,
          border: `1px solid ${color}30`,
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
        {s.replace(/_/g, ' ')} ({c})
      </span>
    );
  });
}

function formatINR(n) {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

export default function RevenueSection({ dateRange }) {
  const period = dateRange.preset;
  const [granularity, setGranularity] = useState('day');

  const overviewQ = useAnalyticsFetch(
    useCallback(() => getAnalyticsOverview({ period }), [period]),
    [period],
  );
  const revenueQ = useAnalyticsFetch(
    useCallback(() => getRevenueAnalytics({ period, granularity }), [period, granularity]),
    [period, granularity],
  );

  const chartConfig = useMemo(() => {
    const data = revenueQ.data;
    if (!Array.isArray(data) || data.length === 0) return null;
    return {
      data: {
        labels: data.map((d) => d.date),
        datasets: [
          {
            type: 'line',
            label: 'Revenue (₹)',
            data: data.map((d) => d.revenue_rs),
            borderColor: '#4f46e5',
            backgroundColor: 'rgba(79,70,229,.1)',
            fill: true,
            tension: 0.3,
            yAxisID: 'y',
            pointRadius: 2,
          },
          {
            type: 'bar',
            label: 'Orders',
            data: data.map((d) => d.order_count),
            backgroundColor: 'rgba(22,163,74,.6)',
            borderRadius: 4,
            yAxisID: 'y1',
            barPercentage: 0.6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            labels: { font: { size: 11 }, usePointStyle: true, pointStyleWidth: 10 },
          },
        },
        scales: {
          y: {
            position: 'left',
            title: { display: true, text: 'Revenue (₹)', font: { size: 11 } },
            ticks: { callback: (v) => `₹${v.toLocaleString('en-IN')}` },
          },
          y1: {
            position: 'right',
            title: { display: true, text: 'Orders', font: { size: 11 } },
            grid: { drawOnChartArea: false },
          },
          x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
        },
      },
    };
  }, [revenueQ.data]);

  const d = overviewQ.data || {};

  return (
    <>
      <div className="stats" id="an-overview">
        <div className="stat">
          <div className="stat-l">Total Orders</div>
          <div className="stat-v">{d.total_orders ?? '—'}</div>
          <div className="stat-s"><PctChange value={d.changes?.orders_pct} /></div>
        </div>
        <div className="stat">
          <div className="stat-l">Revenue</div>
          <div className="stat-v">{d.total_revenue_rs != null ? formatINR(d.total_revenue_rs) : '—'}</div>
          <div className="stat-s"><PctChange value={d.changes?.revenue_pct} /></div>
        </div>
        <div className="stat">
          <div className="stat-l">Avg Order Value</div>
          <div className="stat-v">{d.avg_order_value_rs != null ? formatINR(d.avg_order_value_rs) : '—'}</div>
        </div>
        <div className="stat">
          <div className="stat-l">Customers</div>
          <div className="stat-v">{d.total_customers ?? '—'}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.1rem' }}>
        <div className="ch"><h3>Order Status Breakdown</h3></div>
        <div className="cb" style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
          {overviewQ.error ? (
            <SectionError message={overviewQ.error} onRetry={overviewQ.refetch} />
          ) : (
            <StatusBreakdown breakdown={d.orders_by_status} />
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.1rem' }}>
        <div className="ch">
          <h3>Revenue &amp; Orders</h3>
          <div className="chips" style={{ margin: 0 }}>
            {GRANULARITY_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={granularity === value ? 'chip on' : 'chip'}
                onClick={() => setGranularity(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="cb" style={{ height: 320, position: 'relative' }}>
          {revenueQ.error ? (
            <SectionError message={revenueQ.error} onRetry={revenueQ.refetch} />
          ) : chartConfig ? (
            <ChartCanvas type="bar" data={chartConfig.data} options={chartConfig.options} height={320} />
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--dim)', padding: '3rem 0', fontSize: '.85rem' }}>
              {revenueQ.loading ? 'Loading…' : 'No revenue data for this period'}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
