import { useState } from 'react';
import RevenueSection from '../../components/dashboard/analytics/RevenueSection.jsx';
import TopItemsSection from '../../components/dashboard/analytics/TopItemsSection.jsx';
import PeakHoursSection from '../../components/dashboard/analytics/PeakHoursSection.jsx';
import CustomersSection from '../../components/dashboard/analytics/CustomersSection.jsx';
import DeliverySection from '../../components/dashboard/analytics/DeliverySection.jsx';
import DropoffsSection from '../../components/dashboard/analytics/DropoffsSection.jsx';
import RecoverySection from '../../components/dashboard/analytics/RecoverySection.jsx';

// Period chips from dashboard.html:482-487 — default 7d. Legacy has no
// custom-range picker; 'today' is added for the drop-off section's 1-day
// view which legacy exposes via a separate chip.
const PRESETS = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];

export default function AnalyticsTab() {
  const [dateRange, setDateRange] = useState({ preset: '7d' });

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
