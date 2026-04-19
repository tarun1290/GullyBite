import { useCallback } from 'react';
import SectionError from './SectionError.jsx';
import useAnalyticsFetch from './useAnalyticsFetch.js';
import { getDeliveryAnalytics } from '../../../api/restaurant.js';

// Mirrors anLoadDelivery() in legacy analytics.js:244-260.
function formatINR(n) {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

export default function DeliverySection({ dateRange }) {
  const period = dateRange.preset;
  const { data, loading, error, refetch } = useAnalyticsFetch(
    useCallback(() => getDeliveryAnalytics({ period }), [period]),
    [period],
  );

  const branches = data?.orders_by_branch || [];

  return (
    <div className="card">
      <div className="ch"><h3>Delivery &amp; Branch Performance</h3></div>
      <div className="cb">
        {error ? (
          <SectionError message={error} onRetry={refetch} />
        ) : (
          <>
            <div className="stats" style={{ marginBottom: '1rem' }}>
              <div className="stat">
                <div className="stat-l">Avg Delivery Time</div>
                <div className="stat-v">
                  {data?.avg_delivery_time_min != null ? `${data.avg_delivery_time_min} min` : '—'}
                </div>
              </div>
              <div className="stat">
                <div className="stat-l">Avg Prep Time</div>
                <div className="stat-v">
                  {data?.avg_prep_time_min != null ? `${data.avg_prep_time_min} min` : '—'}
                </div>
              </div>
              <div className="stat">
                <div className="stat-l">Delivered Orders</div>
                <div className="stat-v">{data?.delivered_count ?? (loading ? '…' : 0)}</div>
              </div>
            </div>
            <table className="tbl" style={{ fontSize: '.8rem' }}>
              <thead>
                <tr><th>Branch</th><th>Orders</th><th>Revenue</th></tr>
              </thead>
              <tbody>
                {branches.length === 0 ? (
                  <tr>
                    <td colSpan={3} style={{ color: 'var(--dim)', textAlign: 'center' }}>No data yet</td>
                  </tr>
                ) : (
                  branches.map((b, idx) => (
                    <tr key={b.branch_name || idx}>
                      <td>{b.branch_name}</td>
                      <td>{b.order_count}</td>
                      <td>{formatINR(b.revenue_rs)}</td>
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
