'use client';

import { useCallback } from 'react';
import SectionError from './SectionError';
import useAnalyticsFetch from './useAnalyticsFetch';
import { getDeliveryAnalytics } from '../../../api/restaurant';

interface DateRange { preset: string }

interface BranchPerf {
  branch_name?: string;
  order_count?: number;
  revenue_rs?: number | string;
}

interface DeliveryData {
  avg_delivery_time_min?: number | null;
  avg_prep_time_min?: number | null;
  delivered_count?: number;
  orders_by_branch?: BranchPerf[];
}

interface DeliverySectionProps { dateRange: DateRange }

function formatINR(n?: number | string | null): string {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

export default function DeliverySection({ dateRange }: DeliverySectionProps) {
  const period = dateRange.preset;
  const { data, loading, error, refetch } = useAnalyticsFetch<DeliveryData | null>(
    useCallback(() => getDeliveryAnalytics({ period }) as Promise<DeliveryData | null>, [period]),
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
            <div className="stats mb-4">
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
            <table className="tbl text-[0.8rem]">
              <thead>
                <tr><th>Branch</th><th>Orders</th><th>Revenue</th></tr>
              </thead>
              <tbody>
                {branches.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-dim text-center">No data yet</td>
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
