import { useCallback, useMemo } from 'react';
import ChartCanvas from '../ChartCanvas.jsx';
import SectionError from './SectionError.jsx';
import useAnalyticsFetch from './useAnalyticsFetch.js';
import { getTopItems } from '../../../api/restaurant.js';

// Mirrors anLoadTopItems() in legacy analytics.js:134-161.
export default function TopItemsSection({ dateRange }) {
  const period = dateRange.preset;
  const { data, loading, error, refetch } = useAnalyticsFetch(
    useCallback(() => getTopItems({ period, limit: 10 }), [period]),
    [period],
  );

  const chartConfig = useMemo(() => {
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
    <div className="card" style={{ margin: 0 }}>
      <div className="ch"><h3>Top Selling Items</h3></div>
      <div className="cb" style={{ height: 300, position: 'relative' }}>
        {error ? (
          <SectionError message={error} onRetry={refetch} />
        ) : chartConfig ? (
          <ChartCanvas type="bar" data={chartConfig.data} options={chartConfig.options} height={300} />
        ) : (
          <div style={{ textAlign: 'center', color: 'var(--dim)', padding: '3rem 0', fontSize: '.85rem' }}>
            {loading ? 'Loading…' : 'No items sold in this period'}
          </div>
        )}
      </div>
    </div>
  );
}
