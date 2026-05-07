'use client';

import { useCallback, useMemo } from 'react';
import type { ChartData, ChartOptions } from 'chart.js';
import ChartCanvas from '../ChartCanvas';
import SectionError from './SectionError';
import useAnalyticsFetch from './useAnalyticsFetch';
import { getTopItems } from '../../../api/restaurant';

interface DateRange { preset: string }

interface TopItem {
  item_name: string;
  total_quantity: number;
  total_revenue_rs: number;
}

interface TopItemsSectionProps { dateRange: DateRange }

export default function TopItemsSection({ dateRange }: TopItemsSectionProps) {
  const period = dateRange.preset;
  const { data, loading, error, refetch } = useAnalyticsFetch<TopItem[] | null>(
    useCallback(() => getTopItems({ period, limit: 10 }) as Promise<TopItem[] | null>, [period]),
    [period],
  );

  const chartConfig = useMemo<{ data: ChartData<'bar'>; options: ChartOptions<'bar'> } | null>(() => {
    if (!Array.isArray(data) || data.length === 0) return null;
    return {
      data: {
        labels: data.map((d) => d.item_name),
        datasets: [
          {
            label: 'Quantity',
            data: data.map((d) => d.total_quantity),
            backgroundColor: 'rgba(79,70,229,.7)',
            borderRadius: 4,
          },
          {
            label: 'Revenue (₹)',
            data: data.map((d) => d.total_revenue_rs),
            backgroundColor: 'rgba(217,119,6,.6)',
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: { font: { size: 10 }, usePointStyle: true, pointStyleWidth: 8 },
          },
        },
        scales: {
          x: { ticks: { font: { size: 10 } } },
          y: { ticks: { font: { size: 10 } } },
        },
      },
    };
  }, [data]);

  return (
    <div className="card m-0">
      <div className="ch"><h3>Top Selling Items</h3></div>
      <div className="cb h-[300px] relative">
        {error ? (
          <SectionError message={error} onRetry={refetch} />
        ) : chartConfig ? (
          <ChartCanvas type="bar" data={chartConfig.data} options={chartConfig.options} height={300} />
        ) : (
          <div className="text-center text-dim py-12 text-[0.85rem]">
            {loading ? 'Loading…' : 'No items sold in this period'}
          </div>
        )}
      </div>
    </div>
  );
}
