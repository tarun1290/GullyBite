'use client';

import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { ChartData, ChartOptions, ChartDataset } from 'chart.js';
import ChartCanvas from '../ChartCanvas';
import StatCard from '../../StatCard';
import SectionError from '../analytics/SectionError';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import PendingApprovalNotice, { isPendingApproval } from '../PendingApprovalNotice';
import { useToast } from '../../Toast';
import { getFinancialSummary, getDailyFinancials } from '../../../api/restaurant';

const PERIODS: ReadonlyArray<readonly [string, string]> = [
  ['1d', 'Today'],
  ['7d', 'This Week'],
  ['30d', 'This Month'],
  ['last_month', 'Last Month'],
];

// Field names mirror the exact keys returned by GET /api/restaurant/financials/summary
// (see backend/src/services/financials.js:getFinancialSummary). Renamed from
// the un-suffixed shape because the response uses _rs-suffixed keys at the top
// level — the previous interface caused every breakdown line to render ₹0.
interface Breakdown {
  food_revenue_rs?: number | string;
  food_gst_collected_rs?: number | string;
  packaging_collected_rs?: number | string;
  packaging_gst_rs?: number | string;
  delivery_fee_collected_rs?: number | string;
  delivery_fee_cust_gst_rs?: number | string;
  gross_collections_rs?: number | string;
  platform_fee_rs?: number | string;
  platform_fee_gst_rs?: number | string;
  // Restaurant's absorbed share + GST on it. Both are exposed for UI
  // transparency so the breakdown can show the customer/restaurant
  // split, but they're NOT separately deducted — the deduction line is
  // delivery_costs_rs (the full 3PL fee, since GullyBite paid it
  // upfront).
  delivery_fee_rest_share_rs?: number | string;
  delivery_fee_rest_gst_rs?: number | string;
  delivery_costs_rs?: number | string;
  discount_total_rs?: number | string;
  refund_total_rs?: number | string;
  refund_count?: number;
  // tds not in backend response yet — line will render ₹0 until exposed
  tds_rs?: number | string;
  referral_fee_rs?: number | string;
  referral_fee_gst_rs?: number | string;
  total_deductions_rs?: number | string;
  net_earnings_rs?: number | string;
}

interface FinancialSummary extends Breakdown {
  breakdown?: Breakdown;
  total_revenue?: number | string;
  net_earnings?: number | string;
  orders_count?: number;
  avg_order_value?: number | string;
  revenue_change?: number | null;
  orders_change?: number | null;
}

interface DailyFinancialRow {
  date: string;
  revenue?: number | string;
  net_earnings?: number | string;
  orders?: number | string;
}

interface DailyFinancialsResponse {
  days?: DailyFinancialRow[];
}

interface FetchParams {
  period: string;
  from?: string;
  to?: string;
}

function formatINR(n: number | string | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

function formatDelta(pct: number | null | undefined): string | null {
  if (pct == null) return null;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}% vs prev period`;
}

interface BreakdownLineProps {
  label: string;
  value: number | string | null | undefined;
  sign: '+' | '-' | '';
  tip?: string;
}

function BreakdownLine({ label, value, sign, tip }: BreakdownLineProps) {
  const color = sign === '-' ? 'var(--red,#dc2626)' : sign === '+' ? 'var(--wa)' : 'var(--tx)';
  const signChar = sign === '+' ? '+' : sign === '-' ? '-' : ' ';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '.15rem 0' }}>
      <span style={{ color: 'var(--dim)' }}>
        {label}
        {tip && (
          <span title={tip} style={{ cursor: 'help', color: 'var(--mute,var(--dim))', fontSize: '.72rem', marginLeft: '.3rem' }}>ⓘ</span>
        )}
      </span>
      <span style={{ color, fontWeight: 500 }}>
        {signChar} {formatINR(Math.abs(Number(value) || 0))}
      </span>
    </div>
  );
}

interface BreakdownTotalProps {
  label: string;
  value: number | string | null | undefined;
  color?: string;
}

// Indented, dim, no-sign row that sits under a BreakdownLine to show a
// pure informational sub-component (e.g. how a parent total splits into
// customer-collected vs. restaurant-absorbed). The value here does NOT
// contribute to any total — the parent BreakdownLine above it does.
function BreakdownSubLine({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '.1rem 0',
        paddingLeft: '1.5rem',
        fontSize: '.82em',
      }}
    >
      <span style={{ color: 'var(--mute,var(--dim))' }}>↳ {label}</span>
      <span style={{ color: 'var(--mute,var(--dim))' }}>{formatINR(value)}</span>
    </div>
  );
}

function BreakdownTotal({ label, value, color }: BreakdownTotalProps) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '.25rem 0' }}>
      <span style={{ fontWeight: 700, color: color || 'var(--tx)' }}>{label}</span>
      <span style={{ fontWeight: 700, color: color || 'var(--tx)', fontSize: '.95rem' }}>
        {formatINR(Number(value) || 0)}
      </span>
    </div>
  );
}

const DIVIDER: ReactNode = (
  <div style={{ borderTop: '1px solid var(--rim)', margin: '.5rem 0' }} />
);

function sectionHeader(txt: string, style: CSSProperties = {}): ReactNode {
  return (
    <div style={{
      fontSize: '.72rem',
      fontWeight: 700,
      letterSpacing: '.08em',
      textTransform: 'uppercase',
      color: 'var(--mute,var(--dim))',
      ...style,
    }}
    >
      {txt}
    </div>
  );
}

export default function FinancialSummarySection() {
  const { showToast } = useToast();
  const [period, setPeriod] = useState<string>('1d');
  const [customOpen, setCustomOpen] = useState<boolean>(false);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');

  const paramsForFetch = useMemo<FetchParams>(() => {
    if (period === 'custom') return { period: 'custom', from, to };
    return { period };
  }, [period, from, to]);

  const paramsKey = JSON.stringify(paramsForFetch);

  const summaryQ = useAnalyticsFetch<FinancialSummary | null>(
    useCallback(() => getFinancialSummary({ ...paramsForFetch }) as Promise<FinancialSummary | null>, [paramsForFetch]),
    [paramsKey],
  );
  const dailyQ = useAnalyticsFetch<DailyFinancialsResponse | null>(
    useCallback(() => getDailyFinancials({ ...paramsForFetch }) as Promise<DailyFinancialsResponse | null>, [paramsForFetch]),
    [paramsKey],
  );

  const handleApplyCustom = () => {
    if (!from || !to) { showToast('Select both dates', 'error'); return; }
    setPeriod('custom');
  };

  if (isPendingApproval(summaryQ.error) || isPendingApproval(dailyQ.error)) {
    return <PendingApprovalNotice feature="Payments" />;
  }

  const summary: FinancialSummary = summaryQ.data || {};
  const breakdown: Breakdown = summary.breakdown || summary;
  const days: DailyFinancialRow[] = dailyQ.data?.days || [];

  const chartConfig = useMemo<{ data: ChartData<'bar'>; options: ChartOptions<'bar'> } | null>(() => {
    if (!days.length) return null;
    const revenueDs: ChartDataset<'bar'> = {
      type: 'line',
      label: 'Revenue',
      data: days.map((r) => parseFloat(String(r.revenue ?? '0')) || 0),
      borderColor: '#2563eb',
      backgroundColor: 'rgba(37,99,235,.08)',
      borderWidth: 2,
      pointRadius: 3,
      pointBackgroundColor: '#2563eb',
      tension: 0.3,
      fill: true,
      yAxisID: 'y',
      order: 1,
    } as unknown as ChartDataset<'bar'>;
    const netDs: ChartDataset<'bar'> = {
      type: 'line',
      label: 'Net Earnings',
      data: days.map((r) => parseFloat(String(r.net_earnings ?? '0')) || 0),
      borderColor: '#16a34a',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 3,
      pointBackgroundColor: '#16a34a',
      tension: 0.3,
      fill: false,
      yAxisID: 'y',
      order: 2,
    } as unknown as ChartDataset<'bar'>;
    const ordersDs: ChartDataset<'bar'> = {
      type: 'bar',
      label: 'Orders',
      data: days.map((r) => parseInt(String(r.orders ?? '0'), 10) || 0),
      backgroundColor: 'rgba(148,163,184,.25)',
      borderColor: 'rgba(148,163,184,.4)',
      borderWidth: 1,
      borderRadius: 4,
      yAxisID: 'y1',
      order: 3,
      barPercentage: 0.5,
    };
    return {
      data: {
        labels: days.map((r) => r.date),
        datasets: [revenueDs, netDs, ordersDs],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, padding: 16, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label(ctx) {
                const ds = ctx.dataset as ChartDataset<'bar'> & { yAxisID?: string };
                if (ds.yAxisID === 'y1') return `${ds.label}: ${ctx.raw}`;
                return `${ds.label}: ${formatINR(ctx.raw as number | string)}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: {
            position: 'left',
            grid: { color: 'rgba(0,0,0,.04)' },
            ticks: {
              font: { size: 10 },
              callback: (v) => {
                const n = Number(v);
                return `₹${n >= 1000 ? `${(n / 1000).toFixed(0)}k` : n}`;
              },
            },
          },
          y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 }, stepSize: 1 } },
        },
      },
    };
  }, [days]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '.7rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '.35rem', flexWrap: 'wrap' }}>
          {PERIODS.map(([v, l]) => (
            <button
              key={v}
              type="button"
              className={period === v ? 'fin-period-btn chip on' : 'fin-period-btn chip'}
              onClick={() => { setPeriod(v); setCustomOpen(false); }}
            >
              {l}
            </button>
          ))}
          <button
            type="button"
            id="fin-custom-btn"
            className={period === 'custom' ? 'fin-period-btn chip on' : 'fin-period-btn chip'}
            onClick={() => setCustomOpen((o) => !o)}
          >
            Custom Range
          </button>
        </div>
        {customOpen && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              style={{ fontSize: '.78rem', padding: '.3rem .5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
            />
            <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>to</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              style={{ fontSize: '.78rem', padding: '.3rem .5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
            />
            <button type="button" className="btn-p btn-sm" onClick={handleApplyCustom}>Apply</button>
          </div>
        )}
      </div>

      {summaryQ.error ? (
        <div style={{ marginBottom: '1rem' }}>
          <SectionError message={summaryQ.error} onRetry={summaryQ.refetch} />
        </div>
      ) : (
        <div className="stats" style={{ marginBottom: '1.2rem' }}>
          <StatCard
            label="Total Revenue"
            value={summaryQ.loading && !summaryQ.data ? '…' : formatINR(summary.total_revenue)}
            delta={formatDelta(summary.revenue_change)}
            deltaType={summary.revenue_change != null && summary.revenue_change < 0 ? 'down' : 'up'}
          />
          <StatCard
            label="Net Earnings"
            value={summaryQ.loading && !summaryQ.data ? '…' : formatINR(summary.net_earnings)}
          />
          <StatCard
            label="Orders"
            value={summaryQ.loading && !summaryQ.data ? '…' : (summary.orders_count ?? 0)}
            delta={formatDelta(summary.orders_change)}
            deltaType={summary.orders_change != null && summary.orders_change < 0 ? 'down' : 'up'}
          />
          <StatCard
            label="Avg Order Value"
            value={summaryQ.loading && !summaryQ.data ? '…' : formatINR(summary.avg_order_value)}
          />
        </div>
      )}

      <div className="card" style={{ marginBottom: '1.2rem' }}>
        <div className="ch"><h3>Revenue &amp; Earnings Trend</h3></div>
        <div className="cb" style={{ padding: '1rem 1.1rem' }}>
          {dailyQ.error ? (
            <SectionError message={dailyQ.error} onRetry={dailyQ.refetch} />
          ) : !days.length ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--dim)', fontSize: '.84rem' }}>
              {dailyQ.loading ? 'Loading…' : 'No data for the selected period'}
            </div>
          ) : chartConfig ? (
            <ChartCanvas type="bar" data={chartConfig.data} options={chartConfig.options} height={320} />
          ) : null}
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.2rem' }}>
        <div className="ch"><h3>Earnings Breakdown</h3></div>
        <div className="cb" style={{ padding: 0 }}>
          <div
            id="fin-breakdown"
            style={{
              fontFamily: "'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace",
              fontSize: '.82rem',
              padding: '1.2rem 1.5rem',
              lineHeight: 2,
            }}
          >
            {summaryQ.loading && !summaryQ.data ? (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--dim)', fontFamily: 'var(--font-body)' }}>
                Loading breakdown…
              </div>
            ) : (
              <>
                {sectionHeader('EARNINGS SUMMARY', { marginBottom: '.4rem', fontFamily: 'var(--font-body)' })}
                {DIVIDER}
                <BreakdownLine label="Food Revenue" value={breakdown.food_revenue_rs} sign="" tip="Revenue from food items sold" />
                <BreakdownLine label="Food GST (5%)" value={breakdown.food_gst_collected_rs} sign="+" tip="GST collected on food orders" />
                <BreakdownLine label="Packaging" value={breakdown.packaging_collected_rs} sign="+" tip="Packaging charges collected" />
                <BreakdownLine label="Packaging GST" value={breakdown.packaging_gst_rs} sign="+" tip="GST on packaging" />
                <BreakdownLine label="Delivery Fee (Customer)" value={breakdown.delivery_fee_collected_rs} sign="+" tip="Delivery charges paid by customers" />
                <BreakdownLine label="Customer Delivery GST" value={breakdown.delivery_fee_cust_gst_rs} sign="+" tip="GST collected on the customer's delivery share" />
                {DIVIDER}
                <BreakdownTotal label="GROSS COLLECTIONS" value={breakdown.gross_collections_rs} color="var(--acc)" />
                {DIVIDER}
                {sectionHeader('DEDUCTIONS', { margin: '.5rem 0 .3rem', fontFamily: 'var(--font-body)' })}
                <BreakdownLine label="Platform Fee" value={breakdown.platform_fee_rs} sign="-" tip="GullyBite platform commission" />
                <BreakdownLine label="Platform Fee GST (18%)" value={breakdown.platform_fee_gst_rs} sign="-" tip="GST charged on platform fee" />
                {/* Full 3PL delivery fee — GullyBite paid the rider upfront, so
                    the restaurant reimburses the platform regardless of the
                    customer/restaurant split. Sub-lines below break down where
                    that fee came from (informational only — only the parent
                    line contributes to TOTAL DEDUCTIONS). */}
                <BreakdownLine label="Total Delivery Fee" value={breakdown.delivery_costs_rs} sign="-" tip="The full 3PL delivery fee paid by GullyBite (customer's share + customer GST + restaurant's absorbed share + GST on absorbed share). Customers paying 100% of delivery cancel this out against the GROSS line above; restaurants absorbing a share see the absorbed portion as a net deduction." />
                <BreakdownSubLine
                  label="Customer Collected"
                  value={(Number(breakdown.delivery_fee_collected_rs) || 0) + (Number(breakdown.delivery_fee_cust_gst_rs) || 0)}
                />
                <BreakdownSubLine
                  label="Restaurant Absorbed"
                  value={(Number(breakdown.delivery_fee_rest_share_rs) || 0) + (Number(breakdown.delivery_fee_rest_gst_rs) || 0)}
                />
                <BreakdownLine label="Discounts" value={breakdown.discount_total_rs} sign="-" tip="Discount amounts funded by restaurant" />
                <BreakdownLine label="Refunds" value={breakdown.refund_total_rs} sign="-" tip="Refund amounts for cancelled/returned orders" />
                <BreakdownLine label="TDS (1%)" value={breakdown.tds_rs} sign="-" tip="Tax Deducted at Source u/s 194-O" />
                <BreakdownLine label="Referral Fee" value={breakdown.referral_fee_rs} sign="-" tip="Referral commission for referred customers" />
                <BreakdownLine label="Referral Fee GST" value={breakdown.referral_fee_gst_rs} sign="-" tip="GST on referral fees" />
                {DIVIDER}
                <BreakdownTotal label="TOTAL DEDUCTIONS" value={breakdown.total_deductions_rs} color="var(--red,#dc2626)" />
                {DIVIDER}
                <BreakdownTotal label="NET PAYOUT" value={breakdown.net_earnings_rs} color="var(--wa)" />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
