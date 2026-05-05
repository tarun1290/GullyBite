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
    return <div style={{ color: 'var(--dim)' }}>Loading…</div>;
  }
  if (!stats || !stats.total_sent) {
    return (
      <span style={{ color: 'var(--dim)' }}>
        No recovery messages sent yet. Use the &quot;Send Recovery&quot; button above to win back abandoned carts.
      </span>
    );
  }
  return (
    <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
      <div>
        <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>{stats.total_sent}</span>{' '}
        <span style={{ color: 'var(--dim)' }}>messages sent</span>
      </div>
      <div>
        <span style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--wa)' }}>{stats.recovered}</span>{' '}
        <span style={{ color: 'var(--dim)' }}>orders recovered</span>
      </div>
      <div>
        <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>{stats.recovery_rate}%</span>{' '}
        <span style={{ color: 'var(--dim)' }}>conversion rate</span>
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
    return <div style={{ color: 'var(--dim)' }}>Failed to load cart recovery data</div>;
  }
  if (loading && !data) {
    return <div style={{ color: 'var(--dim)' }}>Loading…</div>;
  }
  if (!data) return <div style={{ color: 'var(--dim)' }}>No data yet</div>;
  const stages = data.by_stage || {};
  const rows = ['address_pending', 'review_pending', 'payment_pending', 'payment_failed'].map((s) => {
    const st = stages[s] || { abandoned: 0, recovered: 0 };
    const abandoned = st.abandoned || 0;
    const recovered = st.recovered || 0;
    const pct = abandoned ? Math.round((recovered / abandoned) * 100) : 0;
    return (
      <div key={s} style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.35rem 0', borderBottom: '1px solid var(--bdr,#e5e7eb)' }}>
        <span style={{ width: 100 }}>{STAGE_LABELS[s] || s}</span>
        <span style={{ flex: 1 }}>
          <div style={{ height: 6, background: 'var(--rim,#e5e7eb)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--wa)', borderRadius: 3 }} />
          </div>
        </span>
        <span style={{ width: 70, textAlign: 'right', fontSize: '.76rem' }}>
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
        <div style={{ marginTop: '.6rem', fontSize: '.76rem', color: 'var(--dim)' }}>
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
      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="ch"><h3>Recovery Performance</h3></div>
        <div style={{ fontSize: '.85rem', color: 'var(--dim)', padding: '.5rem 0' }}>
          <RecoveryStatsBlock
            stats={statsQ.data}
            loading={statsQ.loading}
            error={statsQ.error}
            onRetry={statsQ.refetch}
          />
        </div>
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="ch"><h3>Cart Recovery</h3></div>
        <div className="cb">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))',
              gap: '.8rem',
              marginBottom: '1rem',
            }}
          >
            <div className="card" style={{ textAlign: 'center', padding: '.8rem' }}>
              <div style={{ fontSize: '.72rem', color: 'var(--dim)' }}>Abandoned</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{cr.total_abandoned ?? '—'}</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '.8rem' }}>
              <div style={{ fontSize: '.72rem', color: 'var(--dim)' }}>Recovered</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#22c55e' }}>{cr.total_recovered ?? '—'}</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '.8rem' }}>
              <div style={{ fontSize: '.72rem', color: 'var(--dim)' }}>Recovery Rate</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--wa)' }}>
                {cr.recovery_rate != null ? `${cr.recovery_rate}%` : '—'}
              </div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: '.8rem' }}>
              <div style={{ fontSize: '.72rem', color: 'var(--dim)' }}>Revenue Recovered</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--gold,#eab308)' }}>
                {cr.revenue_recovered != null ? formatINR(cr.revenue_recovered) : '—'}
              </div>
            </div>
          </div>
          <div style={{ fontSize: '.82rem', color: 'var(--dim)' }}>
            <CartRecoveryFunnel data={crQ.data} loading={crQ.loading} error={crQ.error} />
          </div>
        </div>
      </div>
    </>
  );
}
