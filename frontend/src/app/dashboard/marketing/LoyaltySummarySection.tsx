'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Card from '../../../components/Card';
import StatCard from '../../../components/StatCard';
import { getLoyaltySummary } from '../../../api/restaurant';

// Period chips lifted verbatim from the (being-deleted) marketing-analytics page.
const PERIODS: ReadonlyArray<readonly [string, string]> = [
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];

// Tailwind needs static class literals — map runtime column count to a
// static `grid-cols-N` class (only 2/3/4 are used by the lifted sections).
const GRID_COLS: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
};

function fmtRs(n: number | string | null | undefined): string {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(1) + 'Cr';
  if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
  if (Math.abs(v) >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
  return '₹' + v.toFixed(0);
}

function fmtNum(n: number | string | null | undefined): string {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-IN');
}

interface SectionCardProps {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  empty?: string | null;
  loading?: boolean;
}

function SectionCard({ title, subtitle, children, empty, loading }: SectionCardProps) {
  return (
    <Card title={title} className="marketing-analytics-section">
      {subtitle && (
        <div className="text-sm text-slate-500 mb-3">
          {subtitle}
        </div>
      )}
      {loading ? (
        <div className="py-4 px-0 text-slate-400 text-base">Loading…</div>
      ) : empty ? (
        <div className="py-4 px-0 text-slate-400 text-base">{empty}</div>
      ) : (
        children
      )}
    </Card>
  );
}

interface StatGridProps { children?: ReactNode; cols?: number }

function StatGrid({ children, cols = 4 }: StatGridProps) {
  return (
    <div className={`grid gap-3 ${GRID_COLS[cols] || GRID_COLS[4]}`}>
      {children}
    </div>
  );
}

interface LoyaltyData {
  program_active?: boolean;
  enrolled_customers?: number;
  outstanding_points?: number;
  outstanding_liability_rs?: number | string;
  lifetime_points?: number;
  points_earned_in_period?: number;
  points_redeemed_in_period?: number;
  redemption_count_in_period?: number;
  redemption_value_rs?: number | string;
}

interface LoyaltySummaryResponse {
  ok?: boolean;
  data?: LoyaltyData;
}

interface LoyaltySectionProps { data?: LoyaltyData | undefined; loading: boolean }

function LoyaltySection({ data, loading }: LoyaltySectionProps) {
  const inactive = !loading && data && !data.program_active;
  return (
    <SectionCard
      title="Loyalty Program"
      subtitle="Points earned, redeemed, outstanding liability."
      loading={loading}
      empty={inactive ? 'Loyalty program is inactive. Enable it from the Loyalty tab.' : null}
    >
      {data && data.program_active && (
        <StatGrid cols={4}>
          <StatCard label="Enrolled" value={fmtNum(data.enrolled_customers)} />
          <StatCard label="Outstanding points" value={fmtNum(data.outstanding_points)} />
          <StatCard label="Liability" value={fmtRs(data.outstanding_liability_rs)} />
          <StatCard label="Lifetime points" value={fmtNum(data.lifetime_points)} />
          <StatCard label="Points earned" value={fmtNum(data.points_earned_in_period)} />
          <StatCard label="Points redeemed" value={fmtNum(data.points_redeemed_in_period)} />
          <StatCard label="Redemptions" value={fmtNum(data.redemption_count_in_period)} />
          <StatCard label="Redemption value" value={fmtRs(data.redemption_value_rs)} />
        </StatGrid>
      )}
    </SectionCard>
  );
}

export default function LoyaltySummarySection() {
  const [period, setPeriod] = useState<string>('30d');
  const [loading, setLoading] = useState<boolean>(true);
  const [data, setData] = useState<LoyaltyData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getLoyaltySummary(period)
      .then((resRaw: unknown) => {
        if (cancelled) return;
        const res = resRaw as LoyaltySummaryResponse | null | undefined;
        if (!res || res.ok === false) {
          setError('Could not load loyalty stats. Try again.');
          setData(null);
        } else {
          setData(res.data || null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError('Could not load loyalty stats. Try again.');
        setData(null);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [period]);

  return (
    <div className="mb-4">
      <div className="chips mb-4">
        {PERIODS.map(([val, label]) => (
          <button
            key={val}
            type="button"
            className={period === val ? 'chip on' : 'chip'}
            onClick={() => setPeriod(val)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-100 border border-red-200 rounded-lg py-3 px-4 text-base text-red-800 mb-4">
          {error}
        </div>
      )}

      <LoyaltySection data={data ?? undefined} loading={loading} />
    </div>
  );
}
