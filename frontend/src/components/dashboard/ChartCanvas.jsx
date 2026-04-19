import { useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';

// One-shot registration for all controllers/scales/elements Chart.js ships with.
// Idempotent — calling multiple times is safe.
Chart.register(...registerables);

// Thin React wrapper around a Chart.js instance. Uses a ref for the canvas and
// a ref for the chart so updating data/options does NOT destroy/recreate the
// chart unless the type changes — matches the `new Chart(ctx, ...)` usage in
// legacy analytics.js (with _destroyChart on refresh).
export default function ChartCanvas({ type, data, options, height = 300 }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const typeRef = useRef(type);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return undefined;
    chartRef.current = new Chart(ctx, { type, data, options });
    typeRef.current = type;
    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (typeRef.current !== type) {
      chart.destroy();
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;
      chartRef.current = new Chart(ctx, { type, data, options });
      typeRef.current = type;
      return;
    }
    chart.data = data;
    if (options) chart.options = options;
    chart.update();
  }, [type, data, options]);

  return (
    <div style={{ height, position: 'relative' }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
