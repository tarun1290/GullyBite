'use client';

import { useCallback, useMemo } from 'react';
import type { ChartData, ChartOptions } from 'chart.js';
import ChartCanvas from '../../shared/ChartCanvas';
import SectionError from './SectionError';
import useAnalyticsFetch from './useAnalyticsFetch';
import { getCustomerAnalytics } from '../../../api/restaurant';

interface DateRange { preset: string }

interface TopCustomer {
  bsuid?: string;
  wa_phone?: string;
  name?: string;
  order_count?: number;
  total_spent_rs?: number | string;
}

interface CustomerAnalytics {
  new_customers?: number;
  returning_customers?: number;
  repeat_rate_pct?: number;
  avg_orders_per_customer?: number;
  top_customers?: TopCustomer[];
}

interface CustomersSectionProps { dateRange: DateRange }

function formatINR(n?: number | string | null): string {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

function shortBsuid(b?: string): string {
  return b ? `${String(b).slice(0, 12)}…` : '';
}

export default function CustomersSection({ dateRange }: CustomersSectionProps) {
  const period = dateRange.preset;
  const { data, loading, error, refetch } = useAnalyticsFetch<CustomerAnalytics | null>(
    useCallback(() => getCustomerAnalytics({ period }) as Promise<CustomerAnalytics | null>, [period]),
    [period],
  );

  const donutConfig = useMemo<{ data: ChartData<'doughnut'>; options: ChartOptions<'doughnut'> } | null>(() => {
    if (!data) return null;
    return {
      data: {
        labels: ['New', 'Returning'],
        datasets: [
          {
            data: [data.new_customers || 0, data.returning_customers || 0],
            backgroundColor: ['#4f46e5', '#16a34a'],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
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
    <div className="card m-0">
      <div className="ch"><h3>Customer Insights</h3></div>
      <div className="cb">
        {error ? (
          <SectionError message={error} onRetry={refetch} />
        ) : (
          <>
            <div className="flex gap-5 items-center mb-4">
              <div className="w-[160px] h-[160px] relative">
                {donutConfig && (
                  <ChartCanvas type="doughnut" data={donutConfig.data} options={donutConfig.options} height={160} />
                )}
              </div>
              <div
                id="an-cust-stats"
                className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4 flex-1"
              >
                {loading && !data ? (
                  <div className="text-sm text-dim">Loading…</div>
                ) : data ? (
                  <>
                    <div>
                      <div className="text-xs text-dim uppercase tracking-wide">New Customers</div>
                      <div className="text-lg font-semibold text-tx">{data.new_customers ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-xs text-dim uppercase tracking-wide">Returning</div>
                      <div className="text-lg font-semibold text-tx">{data.returning_customers ?? 0}</div>
                    </div>
                    <div>
                      <div className="text-xs text-dim uppercase tracking-wide">Repeat Rate</div>
                      <div className="text-lg font-semibold text-tx">{data.repeat_rate_pct ?? 0}%</div>
                    </div>
                    <div>
                      <div className="text-xs text-dim uppercase tracking-wide">Avg Orders</div>
                      <div className="text-lg font-semibold text-tx">{data.avg_orders_per_customer ?? 0}</div>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
            <table className="tbl text-sm">
              <thead>
                <tr><th>Customer</th><th>Phone</th><th>Orders</th><th>Spent</th></tr>
              </thead>
              <tbody>
                {topCustomers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-dim text-center">No data yet</td>
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
