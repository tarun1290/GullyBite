'use client';

import { useState } from 'react';
import RevenueSection from '../../../components/restaurant/analytics/RevenueSection';
import TopItemsSection from '../../../components/restaurant/analytics/TopItemsSection';
import PeakHoursSection from '../../../components/restaurant/analytics/PeakHoursSection';
import CustomersSection from '../../../components/restaurant/analytics/CustomersSection';
import DeliverySection from '../../../components/restaurant/analytics/DeliverySection';
import DropoffsSection from '../../../components/restaurant/analytics/DropoffsSection';
import RecoverySection from '../../../components/restaurant/analytics/RecoverySection';

const PRESETS: ReadonlyArray<readonly [string, string]> = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];

interface DateRange { preset: string }

export default function AnalyticsPage() {
  const [dateRange, setDateRange] = useState<DateRange>({ preset: '7d' });

  return (
    // pb-16 md:pb-0 is page-local: dashboard/layout.tsx has no global
    // bottom padding, so content must clear the fixed mobile PwaInstallBanner.
    <div id="tab-analytics" className="pb-16 md:pb-0">
      {/* Single flex column owns all vertical rhythm: every top-level
          section is spaced by one gap-6 step. Per-section mb-* and
          standalone spacer divs were removed so the gap is uniform. */}
      <div className="flex flex-col gap-6">
        <div className="chips" id="an-period-chips">
          {PRESETS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={dateRange.preset === value ? 'chip on' : 'chip'}
              onClick={() => setDateRange({ preset: value })}
            >
              {label}
            </button>
          ))}
        </div>

        <RevenueSection dateRange={dateRange} />

        {/* Shared grid parent: TopItems + PeakHoursSection's two cards are
            direct grid children so the day-of-week card can break out
            full-width (col-span-full) on its own row below the grid. */}
        <div className="grid grid-cols-2 gap-4">
          <TopItemsSection dateRange={dateRange} />
          <PeakHoursSection dateRange={dateRange} />
        </div>

        <CustomersSection dateRange={dateRange} />

        <DeliverySection dateRange={dateRange} />

        <DropoffsSection dateRange={dateRange} />

        <RecoverySection dateRange={dateRange} />
      </div>
    </div>
  );
}
