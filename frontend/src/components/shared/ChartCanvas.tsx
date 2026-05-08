'use client';

// Shared Chart.js wrapper. Used by both /admin/* and /dashboard/*
// pages — moved here from components/restaurant/ when it became
// clear admin pages were importing across folder boundaries.
//
// Modernised defaults: dashboard-matching font, subtle dotted grid,
// dark-slate tooltip, hidden line points, brand palette cycle, and
// a vertical gradient fill for filled line charts. Defaults are
// applied once at module load — every consumer inherits them
// without per-instance config.

import { useEffect, useRef } from 'react';
import {
  Chart,
  registerables,
  type ChartType,
  type ChartData,
  type ChartOptions,
  type Plugin,
} from 'chart.js';

// One-shot Chart.js controller/scale/element registration. Idempotent —
// safe across HMR + multiple ChartCanvas mounts.
Chart.register(...registerables);

// Brand palette — applied as the default borderColor / backgroundColor
// cycle for datasets that don't specify their own. Mirrors the
// dashboard's accent token set so charts feel of-a-piece with the rest
// of the UI.
const PALETTE = ['#0F766E', '#F9C303', '#E42623', '#0D5F3C'];

// One-time defaults installer. Re-running is a no-op (the boolean gate
// short-circuits) so HMR / multiple chart mounts don't reapply.
let _defaultsApplied = false;
function applyDefaults() {
  if (_defaultsApplied) return;
  _defaultsApplied = true;

  // Font family — pull the body's computed font so chart text matches
  // the dashboard typography. Canvas doesn't resolve CSS vars, so we
  // grab the resolved value once at runtime. SSR fallback is a
  // platform-safe stack.
  let fontFamily: string | undefined;
  try {
    if (typeof document !== 'undefined' && document.body) {
      fontFamily = getComputedStyle(document.body).fontFamily || undefined;
    }
  } catch {
    /* SSR / non-DOM environment — fall through to the literal stack. */
  }
  Chart.defaults.font.family = fontFamily
    || 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  Chart.defaults.font.size = 12;

  // Animation
  Chart.defaults.animation = {
    duration: 500,
    easing: 'easeInOutQuart',
  };

  // Tooltip — dark slate, transparent border, 8px radius. titleFont /
  // bodyFont sized 13 per spec; the global font.size: 12 above covers
  // tick labels, this overrides for the tooltip surface.
  Chart.defaults.plugins.tooltip = {
    ...Chart.defaults.plugins.tooltip,
    backgroundColor: '#1e293b',
    titleColor: '#f8fafc',
    bodyColor: '#cbd5e1',
    titleFont: { size: 13, weight: 'bold' },
    bodyFont: { size: 13 },
    borderColor: 'transparent',
    borderWidth: 0,
    cornerRadius: 8,
    padding: 10,
    displayColors: true,
  };

  // Scale grid + border + ticks. The `scale` key on Chart.defaults is
  // the base config every scale type inherits from. Casting through
  // `unknown` because chart.js's TS typings on the merged scale
  // defaults are intentionally narrow.
  const scaleDefaults = (Chart.defaults as unknown as {
    scale: {
      grid: { color: string; borderDash: number[] };
      border: { display: boolean };
      ticks: { padding: number };
    };
  }).scale;
  scaleDefaults.grid.color = '#e5e7eb';
  scaleDefaults.grid.borderDash = [4, 4];
  scaleDefaults.border.display = false;
  scaleDefaults.ticks.padding = 8;

  // Line element point defaults — hidden by default (cleaner look),
  // 5px on hover so the tooltip still has a visible anchor.
  if (Chart.defaults.elements?.point) {
    Chart.defaults.elements.point.radius = 0;
    Chart.defaults.elements.point.hoverRadius = 5;
  }
}

// Hex / rgb(a) → rgba helper. Used by the gradient plugin to derive
// alpha-stepped stops from the dataset's solid borderColor. Falls
// through with the input unchanged when it can't be parsed (CSS var
// strings, named colors) — gradients may still work if the browser
// resolves the input itself, otherwise the dataset just keeps its
// existing backgroundColor.
function colorToRgba(input: string, alpha: number): string {
  const hexMatch = input.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    let h = hexMatch[1] || '';
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgbaMatch = input.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbaMatch) {
    return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${alpha})`;
  }
  return input;
}

// Loose dataset shape for plugin internals — chart.js's per-type
// dataset typings make cross-type iteration noisy. We only touch
// borderColor / backgroundColor / fill, so a focused interface keeps
// the plugin lean without `any`.
interface PluginDataset {
  fill?: boolean | string | number;
  borderColor?: unknown;
  backgroundColor?: unknown;
}

// Default-palette plugin. Walks the dataset list before draw and
// assigns palette colors to anything that doesn't carry its own. Per
// chart.js v4 mixed-type semantics, dataset type is read from the
// dataset's own meta (chart.config.type is the chart-level fallback
// and not always present on the discriminated config union). Line
// charts get a borderColor only — backgroundColor for filled lines
// is owned by the gradient plugin below. Bar / pie / doughnut get a
// solid or array fill from the palette.
const palettePlugin: Plugin = {
  id: 'gbDefaultPalette',
  beforeDatasetsUpdate(chart) {
    chart.data.datasets.forEach((rawDs, i) => {
      const ds = rawDs as unknown as PluginDataset;
      const meta = chart.getDatasetMeta(i);
      const datasetType = meta.type;
      const c = PALETTE[i % PALETTE.length];
      if (ds.borderColor === undefined) ds.borderColor = c;
      if (ds.backgroundColor === undefined) {
        if (datasetType === 'doughnut' || datasetType === 'pie') {
          ds.backgroundColor = PALETTE;
        } else if (datasetType !== 'line') {
          ds.backgroundColor = c;
        }
        // Line+fill datasets are intentionally left undefined here —
        // the gradient plugin below assigns a CanvasGradient at draw
        // time, which depends on chartArea (only available after layout).
      }
    });
  },
};

// Gradient-fill plugin for filled line charts. Runs every draw so the
// gradient stays correct across responsive resizes. Reads the
// dataset's resolved borderColor (or palette fallback) as the source
// color, top of chartArea at 0.25 alpha → bottom at 0. Skips
// datasets where fill isn't enabled or the chart is not a line.
const gradientLineFillPlugin: Plugin = {
  id: 'gbLineGradient',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea } = chart;
    if (!chartArea) return;
    chart.data.datasets.forEach((rawDs, i) => {
      const ds = rawDs as unknown as PluginDataset;
      const meta = chart.getDatasetMeta(i);
      if (meta.type !== 'line') return;
      // Only fill: true / 'origin' get the gradient. fill: false /
      // 'start' / 'end' / a number index are left alone — those have
      // intentional non-default fill semantics the consumer set.
      if (ds.fill !== true && ds.fill !== 'origin') return;
      const colorStr = typeof ds.borderColor === 'string'
        ? ds.borderColor
        : PALETTE[i % PALETTE.length] || PALETTE[0]!;
      const grad = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      grad.addColorStop(0, colorToRgba(colorStr, 0.25));
      grad.addColorStop(1, colorToRgba(colorStr, 0));
      ds.backgroundColor = grad;
    });
  },
};

Chart.register(palettePlugin, gradientLineFillPlugin);

interface ChartCanvasProps {
  type: ChartType;
  data: ChartData;
  options?: ChartOptions;
  height?: number;
}

// Thin React wrapper around a Chart.js instance. Uses a ref for the canvas and
// a ref for the chart so updating data/options does NOT destroy/recreate the
// chart unless the type changes — matches the `new Chart(ctx, ...)` usage in
// legacy analytics.js (with _destroyChart on refresh).
export default function ChartCanvas({ type, data, options, height = 300 }: ChartCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const typeRef = useRef<ChartType>(type);

  useEffect(() => {
    // Apply defaults on first mount — runs once total per page load
    // thanks to the module-level guard. Stays in the effect (vs
    // module-load) so SSR doesn't try to read getComputedStyle.
    applyDefaults();

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
    <div
      className="relative p-4"
      // height is a runtime prop — Tailwind arbitrary values must be
      // statically analyzable at build time, so we keep it inline.
      style={{ height }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
