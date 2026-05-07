'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ChartData, ChartOptions, ChartDataset } from 'chart.js';
import ChartCanvas from '../ChartCanvas';
import SectionError from './SectionError';
import useAnalyticsFetch from './useAnalyticsFetch';
import { getAnalyticsOverview, getRevenueAnalytics } from '../../../api/restaurant';

interface DateRange { preset: string }

const STATUS_COLORS: Record<string, string> = {
  PENDING_PAYMENT: '#94a3b8',
  PAID: '#2563eb',
  CONFIRMED: '#7c3aed',
  PREPARING: '#d97706',
  PACKED: '#0891b2',
  DISPATCHED: '#4f46e5',
  DELIVERED: '#16a34a',
  CANCELLED: '#dc2626',
};

const GRANULARITY_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['day', 'Daily'],
  ['week', 'Weekly'],
  ['month', 'Monthly'],
];

interface OverviewChanges {
  orders_pct?: number | null;
  revenue_pct?: number | null;
}

interface OverviewData {
  total_orders?: number;
  total_revenue_rs?: number | string;
  avg_order_value_rs?: number | string;
  total_customers?: number;
  changes?: OverviewChanges;
  orders_by_status?: Record<string, number>;
}

interface RevenueDataPoint {
  date: string;
  revenue_rs: number;
  order_count: number;
}

interface PctChangeProps { value?: number | null | undefined }

function PctChange({ value }: PctChangeProps) {
  if (value == null) return null;
  const down = value < 0;
  return (
    <span className={`stat-s${down ? ' dn' : ''}`}>
      {down ? '↓' : '↑'} {Math.abs(value)}% vs prev period
    </span>
  );
}

interface StatusBreakdownProps { breakdown?: Record<string, number> | undefined }

function StatusBreakdown({ breakdown }: StatusBreakdownProps) {
  const entries = breakdown ? Object.entries(breakdown) : [];
  if (!entries.length) {
    return <span className="text-dim text-[0.82rem]">No data</span>;
  }
  return (
    <>
      {entries.map(([s, c]) => {
        const color = STATUS_COLORS[s] || '#94a3b8';
        return (
          <span
            key={s}
            className="inline-flex items-center gap-[0.35rem] py-[0.3rem] px-[0.7rem] rounded-full text-[0.75rem] font-medium"
            // background/border/text colour come from the per-status
            // STATUS_COLORS palette at runtime — Tailwind can't pre-bake
            // the 8% / 19% alpha tints (`${color}15` / `${color}30`).
            style={{
              background: `${color}15`,
              color,
              border: `1px solid ${color}30`,
            }}
          >
            <span
              className="w-[7px] h-[7px] rounded-full"
              // Same runtime-palette reason as the parent span.
              style={{ background: color }}
            />
            {s.replace(/_/g, ' ')} ({c})
          </span>
        );
      })}
    </>
  );
}

function formatINR(n?: number | string | null): string {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

interface RevenueSectionProps { dateRange: DateRange }

export default function RevenueSection({ dateRange }: RevenueSectionProps) {
  const period = dateRange.preset;
  const [granularity, setGranularity] = useState<string>('day');

  const overviewQ = useAnalyticsFetch<OverviewData | null>(
    useCallback(() => getAnalyticsOverview({ period }) as Promise<OverviewData | null>, [period]),
    [period],
  );
  const revenueQ = useAnalyticsFetch<RevenueDataPoint[] | null>(
    useCallback(() => getRevenueAnalytics({ period, granularity }) as Promise<RevenueDataPoint[] | null>, [period, granularity]),
    [period, granularity],
  );

  const chartConfig = useMemo<{ data: ChartData<'bar'>; options: ChartOptions<'bar'> } | null>(() => {
    const data = revenueQ.data;
    if (!Array.isArray(data) || data.length === 0) return null;
    // Mixed bar/line: the chart's primary type is 'bar', but the first dataset
    // overrides per-dataset type to render as a line. Chart.js supports this
    // at runtime; the strict ChartDataset<'bar'> type doesn't accept the
    // override, so we widen each dataset.
    const lineDs: ChartDataset<'bar'> = {
      type: 'line',
      label: 'Revenue (₹)',
      data: data.map((d) => d.revenue_rs),
      borderColor: '#4f46e5',
      backgroundColor: 'rgba(79,70,229,.1)',
      fill: true,
      tension: 0.3,
      yAxisID: 'y',
      pointRadius: 2,
    } as unknown as ChartDataset<'bar'>;
    const barDs: ChartDataset<'bar'> = {
      type: 'bar',
      label: 'Orders',
      data: data.map((d) => d.order_count),
      backgroundColor: 'rgba(22,163,74,.6)',
      borderRadius: 4,
      yAxisID: 'y1',
      barPercentage: 0.6,
    };
    return {
      data: {
        labels: data.map((d) => d.date),
        datasets: [lineDs, barDs],
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
            ticks: { callback: (v) => `₹${Number(v).toLocaleString('en-IN')}` },
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

  const d: OverviewData = overviewQ.data || {};

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

      <div className="card mb-[1.1rem]">
        <div className="ch"><h3>Order Status Breakdown</h3></div>
        <div className="cb flex gap-[0.6rem] flex-wrap">
          {overviewQ.error ? (
            <SectionError message={overviewQ.error} onRetry={overviewQ.refetch} />
          ) : (
            <StatusBreakdown breakdown={d.orders_by_status} />
          )}
        </div>
      </div>

      <div className="card mb-[1.1rem]">
        <div className="ch">
          <h3>Revenue &amp; Orders</h3>
          <div className="chips m-0">
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
        <div className="cb h-[320px] relative">
          {revenueQ.error ? (
            <SectionError message={revenueQ.error} onRetry={revenueQ.refetch} />
          ) : chartConfig ? (
            <ChartCanvas type="bar" data={chartConfig.data} options={chartConfig.options} height={320} />
          ) : (
            <div className="text-center text-dim py-12 text-[0.85rem]">
              {revenueQ.loading ? 'Loading…' : 'No revenue data for this period'}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
