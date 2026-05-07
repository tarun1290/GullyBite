'use client';

import { useCallback } from 'react';
import SectionError from './SectionError';
import useAnalyticsFetch from './useAnalyticsFetch';
import { getRecoveryStats, getCartRecovery } from '../../../api/restaurant';

interface DateRange { preset: string }

const PRESET_DAYS: Record<string, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90, all: 365 };

function cartRecoveryPeriod(preset: string): string {
  if (preset === '7d' || preset === 'today') return '7d';
  return '30d';
}

const STAGE_LABELS: Record<string, string> = {
  address_pending: '📍 Address',
  review_pending: '🛒 Review',
  payment_pending: '💳 Payment',
  payment_failed: '❌ Failed',
};

interface RecoveryStats {
  total_sent?: number;
  recovered?: number;
  recovery_rate?: number;
}

interface CartStageBucket {
  abandoned?: number;
  recovered?: number;
}

interface CartReminderBucket {
  sent?: number;
  recovered?: number;
}

interface CartRecoveryData {
  total_abandoned?: number;
  total_recovered?: number;
  recovery_rate?: number;
  revenue_recovered?: number;
  by_stage?: Record<string, CartStageBucket>;
  by_reminder?: Record<string, CartReminderBucket>;
}

interface RecoverySectionProps { dateRange: DateRange }

function formatINR(n?: number | string | null): string {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

interface RecoveryStatsBlockProps {
  stats: RecoveryStats | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

function RecoveryStatsBlock({ stats, loading, error, onRetry }: RecoveryStatsBlockProps) {
  if (error) return <SectionError message={error} onRetry={onRetry} />;
  if (loading && !stats) {
    return <div className="text-dim">Loading…</div>;
  }
  if (!stats || !stats.total_sent) {
    return (
      <span className="text-dim">
        No recovery messages sent yet. Use the &quot;Send Recovery&quot; button above to win back abandoned carts.
      </span>
    );
  }
  return (
    <div className="flex gap-8 flex-wrap">
      <div>
        <span className="font-bold text-[1.1rem]">{stats.total_sent}</span>{' '}
        <span className="text-dim">messages sent</span>
      </div>
      <div>
        <span className="font-bold text-[1.1rem] text-wa">{stats.recovered}</span>{' '}
        <span className="text-dim">orders recovered</span>
      </div>
      <div>
        <span className="font-bold text-[1.1rem]">{stats.recovery_rate}%</span>{' '}
        <span className="text-dim">conversion rate</span>
      </div>
    </div>
  );
}

interface CartRecoveryFunnelProps {
  data: CartRecoveryData | null;
  loading: boolean;
  error: string | null;
}

function CartRecoveryFunnel({ data, loading, error }: CartRecoveryFunnelProps) {
  if (error) {
    return <div className="text-dim">Failed to load cart recovery data</div>;
  }
  if (loading && !data) {
    return <div className="text-dim">Loading…</div>;
  }
  if (!data) return <div className="text-dim">No data yet</div>;
  const stages = data.by_stage || {};
  const rows = ['address_pending', 'review_pending', 'payment_pending', 'payment_failed'].map((s) => {
    const st = stages[s] || { abandoned: 0, recovered: 0 };
    const abandoned = st.abandoned || 0;
    const recovered = st.recovered || 0;
    const pct = abandoned ? Math.round((recovered / abandoned) * 100) : 0;
    return (
      <div key={s} className="flex items-center gap-[0.6rem] py-[0.35rem] border-b border-bdr">
        <span className="w-[100px]">{STAGE_LABELS[s] || s}</span>
        <span className="flex-1">
          <div className="h-[6px] bg-rim rounded-[3px] overflow-hidden">
            <div
              className="h-full bg-wa rounded-[3px]"
              // width is the recovery percentage for this funnel stage —
              // a runtime value the caller computes per stage.
              style={{ width: `${pct}%` }}
            />
          </div>
        </span>
        <span className="w-[70px] text-right text-[0.76rem]">
          {recovered}/{abandoned}
        </span>
      </div>
    );
  });

  const rem = data.by_reminder || {};
  const reminderLines = [1, 2, 3]
    .map((r) => {
      const rd = rem[`reminder_${r}`] || { sent: 0, recovered: 0 };
      return rd.sent ? `R${r}: ${rd.sent} sent → ${rd.recovered} recovered` : null;
    })
    .filter(Boolean);

  return (
    <>
      {rows}
      {reminderLines.length > 0 && (
        <div className="mt-[0.6rem] text-[0.76rem] text-dim">
          {reminderLines.join(' · ')}
        </div>
      )}
    </>
  );
}

export default function RecoverySection({ dateRange }: RecoverySectionProps) {
  const days = PRESET_DAYS[dateRange.preset] || 7;
  const crPeriod = cartRecoveryPeriod(dateRange.preset);

  const statsQ = useAnalyticsFetch<RecoveryStats | null>(
    useCallback(() => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - days * 86400000).toISOString();
      return getRecoveryStats({ from, to }) as Promise<RecoveryStats | null>;
    }, [days]),
    [days],
  );

  const crQ = useAnalyticsFetch<CartRecoveryData | null>(
    useCallback(() => getCartRecovery({ period: crPeriod }) as Promise<CartRecoveryData | null>, [crPeriod]),
    [crPeriod],
  );

  const cr: CartRecoveryData = crQ.data || {};

  return (
    <>
      <div className="card mt-4">
        <div className="ch"><h3>Recovery Performance</h3></div>
        <div className="text-[0.85rem] text-dim py-2">
          <RecoveryStatsBlock
            stats={statsQ.data}
            loading={statsQ.loading}
            error={statsQ.error}
            onRetry={statsQ.refetch}
          />
        </div>
      </div>

      <div className="card mt-4">
        <div className="ch"><h3>Cart Recovery</h3></div>
        <div className="cb">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-[0.8rem] mb-4">
            <div className="card text-center p-[0.8rem]">
              <div className="text-[0.72rem] text-dim">Abandoned</div>
              <div className="text-[1.5rem] font-bold">{cr.total_abandoned ?? '—'}</div>
            </div>
            <div className="card text-center p-[0.8rem]">
              <div className="text-[0.72rem] text-dim">Recovered</div>
              <div className="text-[1.5rem] font-bold text-[#22c55e]">{cr.total_recovered ?? '—'}</div>
            </div>
            <div className="card text-center p-[0.8rem]">
              <div className="text-[0.72rem] text-dim">Recovery Rate</div>
              <div className="text-[1.5rem] font-bold text-wa">
                {cr.recovery_rate != null ? `${cr.recovery_rate}%` : '—'}
              </div>
            </div>
            <div className="card text-center p-[0.8rem]">
              <div className="text-[0.72rem] text-dim">Revenue Recovered</div>
              <div className="text-[1.5rem] font-bold text-gold">
                {cr.revenue_recovered != null ? formatINR(cr.revenue_recovered) : '—'}
              </div>
            </div>
          </div>
          <div className="text-[0.82rem] text-dim">
            <CartRecoveryFunnel data={crQ.data} loading={crQ.loading} error={crQ.error} />
          </div>
        </div>
      </div>
    </>
  );
}
