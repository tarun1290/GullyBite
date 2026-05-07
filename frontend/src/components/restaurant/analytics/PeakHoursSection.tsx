'use client';

import { useCallback, useMemo } from 'react';
import type { ChartData, ChartOptions } from 'chart.js';
import ChartCanvas from '../ChartCanvas';
import SectionError from './SectionError';
import useAnalyticsFetch from './useAnalyticsFetch';
import { getPeakHours } from '../../../api/restaurant';

interface DateRange { preset: string }

interface HourBucket { hour: number; order_count: number }
interface DayBucket { day: string; order_count: number }

interface PeakHoursData {
  hours?: HourBucket[];
  days?: DayBucket[];
}

interface PeakHoursSectionProps { dateRange: DateRange }

const DAY_COLORS = ['#dc2626', '#2563eb', '#7c3aed', '#d97706', '#0891b2', '#4f46e5', '#16a34a'];

function fmtHour(h: number): string {
  if (h === 0) return '12am';
  if (h < 12) return `${h}am`;
  if (h === 12) return '12pm';
  return `${h - 12}pm`;
}

export default function PeakHoursSection({ dateRange }: PeakHoursSectionProps) {
  const period = dateRange.preset;
  const { data, loading, error, refetch } = useAnalyticsFetch<PeakHoursData | null>(
    useCallback(() => getPeakHours({ period }) as Promise<PeakHoursData | null>, [period]),
    [period],
  );

  const hoursConfig = useMemo<{ data: ChartData<'bar'>; options: ChartOptions<'bar'> } | null>(() => {
    const hours = data?.hours;
    if (!Array.isArray(hours) || hours.length === 0) return null;
    const maxVal = Math.max(...hours.map((h) => h.order_count));
    const bgColors = hours.map((h) => {
      if (h.order_count >= maxVal * 0.8) return 'rgba(220,38,38,.7)';
      if (h.order_count >= maxVal * 0.5) return 'rgba(217,119,6,.7)';
      return 'rgba(79,70,229,.5)';
    });
    return {
      data: {
        labels: hours.map((h) => fmtHour(h.hour)),
        datasets: [
          {
            label: 'Orders',
            data: hours.map((h) => h.order_count),
            backgroundColor: bgColors,
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { font: { size: 9 }, maxRotation: 90 } },
          y: { beginAtZero: true, ticks: { stepSize: 1 } },
        },
      },
    };
  }, [data]);

  const daysConfig = useMemo<{ data: ChartData<'bar'>; options: ChartOptions<'bar'> } | null>(() => {
    const days = data?.days;
    if (!Array.isArray(days) || days.length === 0) return null;
    return {
      data: {
        labels: days.map((d) => (d.day || '').slice(0, 3)),
        datasets: [
          {
            label: 'Orders',
            data: days.map((d) => d.order_count),
            backgroundColor: DAY_COLORS.slice(0, days.length),
            borderRadius: 6,
            barPercentage: 0.6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
      },
    };
  }, [data]);

  return (
    <>
      <div className="card m-0">
        <div className="ch"><h3>Peak Order Hours</h3></div>
        <div className="cb h-[300px] relative">
          {error ? (
            <SectionError message={error} onRetry={refetch} />
          ) : hoursConfig ? (
            <ChartCanvas type="bar" data={hoursConfig.data} options={hoursConfig.options} height={300} />
          ) : (
            <div className="text-center text-dim py-12 text-[0.85rem]">
              {loading ? 'Loading…' : 'No hourly data'}
            </div>
          )}
        </div>
      </div>

      <div className="card m-0">
        <div className="ch"><h3>Orders by Day of Week</h3></div>
        <div className="cb h-[250px] relative">
          {error ? null : daysConfig ? (
            <ChartCanvas type="bar" data={daysConfig.data} options={daysConfig.options} height={250} />
          ) : (
            <div className="text-center text-dim py-12 text-[0.85rem]">
              {loading ? 'Loading…' : 'No day-of-week data'}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
