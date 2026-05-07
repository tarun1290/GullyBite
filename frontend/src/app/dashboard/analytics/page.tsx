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
    <div id="tab-analytics">
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

      <div className="grid grid-cols-2 gap-[1.1rem] mb-[1.1rem]">
        <TopItemsSection dateRange={dateRange} />
        <div className="flex flex-col gap-[1.1rem]">
          <PeakHoursSection dateRange={dateRange} />
        </div>
      </div>

      <CustomersSection dateRange={dateRange} />

      <div className="h-[1.1rem]" />

      <DeliverySection dateRange={dateRange} />

      <DropoffsSection dateRange={dateRange} />

      <RecoverySection dateRange={dateRange} />
    </div>
  );
}
