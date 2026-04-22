import { useCallback, useMemo, useState } from 'react';
import ChartCanvas from '../ChartCanvas.jsx';
import StatCard from '../../StatCard.jsx';
import SectionError from '../analytics/SectionError.jsx';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch.js';
import PendingApprovalNotice, { isPendingApproval } from '../PendingApprovalNotice.jsx';
import { useToast } from '../../Toast.jsx';
import { getFinancialSummary, getDailyFinancials } from '../../../api/restaurant.js';

// Mirrors loadFinSummary() + loadFinChart() + renderFinBreakdown() in
// legacy payments.js:37-175. The period chips and custom-range picker
// live here because no other section in the migrated Payments tab
// consumes them (settlements/wallet/tax have their own controls).
const PERIODS = [
  ['1d', 'Today'],
  ['7d', 'This Week'],
  ['30d', 'This Month'],
  ['last_month', 'Last Month'],
];

function formatINR(n) {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

function formatDelta(pct) {
  if (pct == null) return null;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}% vs prev period`;
}

function BreakdownLine({ label, value, sign, tip }) {
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
        {signChar} {formatINR(Math.abs(value || 0))}
      </span>
    </div>
  );
}

function BreakdownTotal({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '.25rem 0' }}>
      <span style={{ fontWeight: 700, color: color || 'var(--tx)' }}>{label}</span>
      <span style={{ fontWeight: 700, color: color || 'var(--tx)', fontSize: '.95rem' }}>
        {formatINR(value || 0)}
      </span>
    </div>
  );
}

const DIVIDER = (
  <div style={{ borderTop: '1px solid var(--rim)', margin: '.5rem 0' }} />
);

const SECTION_HEADER = (txt, style = {}) => (
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

export default function FinancialSummarySection() {
  const { showToast } = useToast();
  const [period, setPeriod] = useState('1d');
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // periodKey is what we send to the backend. For custom ranges, legacy
  // concatenates `custom&from=...&to=...` into the querystring; we use
  // axios params instead, keyed off a sentinel 'custom'.
  const paramsForFetch = useMemo(() => {
    if (period === 'custom') return { period: 'custom', from, to };
    return { period };
  }, [period, from, to]);

  const summaryQ = useAnalyticsFetch(
    useCallback(() => getFinancialSummary(paramsForFetch), [paramsForFetch]),
    [JSON.stringify(paramsForFetch)],
  );
  const dailyQ = useAnalyticsFetch(
    useCallback(() => getDailyFinancials(paramsForFetch), [paramsForFetch]),
    [JSON.stringify(paramsForFetch)],
  );

  const handleApplyCustom = () => {
    if (!from || !to) { showToast('Select both dates', 'error'); return; }
    setPeriod('custom');
  };

  if (isPendingApproval(summaryQ.error) || isPendingApproval(dailyQ.error)) {
    return <PendingApprovalNotice feature="Payments" />;
  }

  const summary = summaryQ.data || {};
  const breakdown = summary.breakdown || summary || {};
  const days = dailyQ.data?.days || [];

  const chartConfig = useMemo(() => {
    if (!days.length) return null;
    return {
      data: {
        labels: days.map((r) => r.date),
        datasets: [
          {
            type: 'line',
            label: 'Revenue',
            data: days.map((r) => parseFloat(r.revenue || 0)),
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37,99,235,.08)',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#2563eb',
            tension: 0.3,
            fill: true,
            yAxisID: 'y',
            order: 1,
          },
          {
            type: 'line',
            label: 'Net Earnings',
            data: days.map((r) => parseFloat(r.net_earnings || 0)),
            borderColor: '#16a34a',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#16a34a',
            tension: 0.3,
            fill: false,
            yAxisID: 'y',
            order: 2,
          },
          {
            type: 'bar',
            label: 'Orders',
            data: days.map((r) => parseInt(r.orders || 0, 10)),
            backgroundColor: 'rgba(148,163,184,.25)',
            borderColor: 'rgba(148,163,184,.4)',
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: 'y1',
            order: 3,
            barPercentage: 0.5,
          },
        ],
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
                if (ctx.dataset.yAxisID === 'y1') return `${ctx.dataset.label}: ${ctx.raw}`;
                return `${ctx.dataset.label}: ${formatINR(ctx.raw)}`;
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
              callback: (v) => `₹${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`,
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
                {SECTION_HEADER('EARNINGS SUMMARY', { marginBottom: '.4rem', fontFamily: 'var(--font-body)' })}
                {DIVIDER}
                <BreakdownLine label="Food Revenue" value={breakdown.food_revenue} sign="" tip="Revenue from food items sold" />
                <BreakdownLine label="Food GST (5%)" value={breakdown.food_gst} sign="+" tip="GST collected on food orders" />
                <BreakdownLine label="Packaging" value={breakdown.packaging_revenue} sign="+" tip="Packaging charges collected" />
                <BreakdownLine label="Packaging GST" value={breakdown.packaging_gst} sign="+" tip="GST on packaging" />
                <BreakdownLine label="Delivery Fee (Customer)" value={breakdown.delivery_fee_customer} sign="+" tip="Delivery charges paid by customers" />
                {DIVIDER}
                <BreakdownTotal label="GROSS COLLECTIONS" value={breakdown.gross_collections} color="var(--acc)" />
                {DIVIDER}
                {SECTION_HEADER('DEDUCTIONS', { margin: '.5rem 0 .3rem', fontFamily: 'var(--font-body)' })}
                <BreakdownLine label="Platform Fee" value={breakdown.platform_fee} sign="-" tip="GullyBite platform commission" />
                <BreakdownLine label="Platform Fee GST (18%)" value={breakdown.platform_fee_gst} sign="-" tip="GST charged on platform fee" />
                <BreakdownLine label="Delivery Cost (Restaurant)" value={breakdown.delivery_cost} sign="-" tip="Delivery partner charges borne by restaurant" />
                <BreakdownLine label="Delivery GST" value={breakdown.delivery_gst} sign="-" tip="GST on delivery cost" />
                <BreakdownLine label="Discounts" value={breakdown.discounts} sign="-" tip="Discount amounts funded by restaurant" />
                <BreakdownLine label="Refunds" value={breakdown.refunds} sign="-" tip="Refund amounts for cancelled/returned orders" />
                <BreakdownLine label="TDS (1%)" value={breakdown.tds} sign="-" tip="Tax Deducted at Source u/s 194-O" />
                <BreakdownLine label="Referral Fee" value={breakdown.referral_fee} sign="-" tip="Referral commission for referred customers" />
                <BreakdownLine label="Referral Fee GST" value={breakdown.referral_fee_gst} sign="-" tip="GST on referral fees" />
                {DIVIDER}
                <BreakdownTotal label="TOTAL DEDUCTIONS" value={breakdown.total_deductions} color="var(--red,#dc2626)" />
                {DIVIDER}
                <BreakdownTotal label="NET PAYOUT" value={breakdown.net_payout} color="var(--wa)" />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
