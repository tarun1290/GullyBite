import { useCallback, useMemo } from 'react';
import ChartCanvas from '../ChartCanvas.jsx';
import SectionError from './SectionError.jsx';
import useAnalyticsFetch from './useAnalyticsFetch.js';
import { getCustomerAnalytics } from '../../../api/restaurant.js';

// Mirrors anLoadCustomers() in legacy analytics.js:210-242.
function formatINR(n) {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

function shortBsuid(b) {
  return b ? `${String(b).slice(0, 12)}…` : '';
}

export default function CustomersSection({ dateRange }) {
  const period = dateRange.preset;
  const { data, loading, error, refetch } = useAnalyticsFetch(
    useCallback(() => getCustomerAnalytics({ period }), [period]),
    [period],
  );

  const donutConfig = useMemo(() => {
    if (!data) return null;
    return {
      data: {
        labels: ['New', 'Returning'],
        datasets: [
          {
            data: [data.new_customers || 0, data.returning_customers || 0],
            backgroundColor: ['#4f46e5', '#16a34a'],
            borderWidth: 0,
            cutout: '65%',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { font: { size: 11 }, usePointStyle: true, padding: 12 },
          },
        },
      },
    };
  }, [data]);

  const topCustomers = data?.top_customers || [];

  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="ch"><h3>Customer Insights</h3></div>
      <div className="cb">
        {error ? (
          <SectionError message={error} onRetry={refetch} />
        ) : (
          <>
            <div style={{ display: 'flex', gap: '1.2rem', alignItems: 'center', marginBottom: '1rem' }}>
              <div style={{ width: 160, height: 160, position: 'relative' }}>
                {donutConfig && (
                  <ChartCanvas type="doughnut" data={donutConfig.data} options={donutConfig.options} height={160} />
                )}
              </div>
              <div id="an-cust-stats" style={{ fontSize: '.82rem', color: 'var(--dim)', lineHeight: 1.8 }}>
                {loading && !data ? (
                  <div>Loading…</div>
                ) : data ? (
                  <>
                    <div><strong>{data.new_customers ?? 0}</strong> new customers</div>
                    <div><strong>{data.returning_customers ?? 0}</strong> returning</div>
                    <div>Repeat rate: <strong>{data.repeat_rate_pct ?? 0}%</strong></div>
                    <div>Avg orders/customer: <strong>{data.avg_orders_per_customer ?? 0}</strong></div>
                  </>
                ) : null}
              </div>
            </div>
            <table className="tbl" style={{ fontSize: '.8rem' }}>
              <thead>
                <tr><th>Customer</th><th>Phone</th><th>Orders</th><th>Spent</th></tr>
              </thead>
              <tbody>
                {topCustomers.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ color: 'var(--dim)', textAlign: 'center' }}>No data yet</td>
                  </tr>
                ) : (
                  topCustomers.map((c, idx) => (
                    <tr key={c.bsuid || c.wa_phone || idx}>
                      <td>{c.name || '—'}</td>
                      <td>{c.wa_phone || shortBsuid(c.bsuid) || '—'}</td>
                      <td>{c.order_count}</td>
                      <td>{formatINR(c.total_spent_rs)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
