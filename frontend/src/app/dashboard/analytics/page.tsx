'use client';

import { useState } from 'react';
import RevenueSection from '../../../components/dashboard/analytics/RevenueSection';
import TopItemsSection from '../../../components/dashboard/analytics/TopItemsSection';
import PeakHoursSection from '../../../components/dashboard/analytics/PeakHoursSection';
import CustomersSection from '../../../components/dashboard/analytics/CustomersSection';
import DeliverySection from '../../../components/dashboard/analytics/DeliverySection';
import DropoffsSection from '../../../components/dashboard/analytics/DropoffsSection';
import RecoverySection from '../../../components/dashboard/analytics/RecoverySection';

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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '1.1rem',
          marginBottom: '1.1rem',
        }}
      >
        <TopItemsSection dateRange={dateRange} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
          <PeakHoursSection dateRange={dateRange} />
        </div>
      </div>

      <CustomersSection dateRange={dateRange} />

      <div style={{ height: '1.1rem' }} />

      <DeliverySection dateRange={dateRange} />

      <DropoffsSection dateRange={dateRange} />

      <RecoverySection dateRange={dateRange} />
    </div>
  );
}
