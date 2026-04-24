'use client';

import { useCallback, useState } from 'react';
import SectionError from './SectionError';
import useAnalyticsFetch from './useAnalyticsFetch';
import { getDropoffs, recoverDropoff } from '../../../api/restaurant';
import { useToast } from '../../Toast';

interface DateRange { preset: string }

const PRESET_DAYS: Record<string, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90, all: 365 };

const STAGE_ICONS: Record<string, string> = {
  initiated: '👋', address: '📍', browsing: '📋',
  cart: '🛒', payment_pending: '💳', payment_failed: '❌',
};
const STAGE_LABELS: Record<string, string> = {
  initiated: 'Started', address: 'Address', browsing: 'Menu',
  cart: 'Cart', payment_pending: 'Payment', payment_failed: 'Failed',
};
const FUNNEL_COLORS = ['#94a3b8', '#3b82f6', '#8b5cf6', '#d97706', '#0891b2', '#16a34a'];

interface FunnelStage {
  stage: string;
  count: number;
  pct: number;
}

interface DropoffItem {
  conversation_id: string;
  customer_name?: string;
  customer_phone?: string;
  stage: string;
  cart_total_rs?: number;
  hours_since_activity?: number;
}

interface DropoffSummary {
  completion_rate?: number;
  dropped_at_cart?: number;
  payment_failed?: number;
  dropped_at_payment?: number;
}

interface DropoffsData {
  summary?: DropoffSummary;
  funnel?: FunnelStage[];
  dropoffs?: DropoffItem[];
}

interface RecoverResult {
  success?: boolean;
}

function maskPhone(phone?: string): string {
  if (!phone) return '—';
  let digits = String(phone).replace(/\D+/g, '');
  if (digits.length > 10 && digits.slice(0, 2) === '91') digits = digits.slice(2);
  if (digits.length !== 10) return '**********';
  return `${digits.slice(0, 2)}*****${digits.slice(-3)}`;
}

function lastActiveLabel(hours?: number): string {
  if (hours == null) return '—';
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface FunnelBarsProps { funnel: FunnelStage[] }

function FunnelBars({ funnel }: FunnelBarsProps) {
  if (!Array.isArray(funnel) || funnel.length === 0) {
    return (
      <p style={{ color: 'var(--dim)', textAlign: 'center', padding: '1rem' }}>
        No data for this period
      </p>
    );
  }
  const rows: React.ReactNode[] = [];
  funnel.forEach((f, i) => {
    const pct = Math.max(f.pct, 2);
    const color = FUNNEL_COLORS[i] || '#64748b';
    rows.push(
      <div key={`stage-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.35rem' }}>
        <span style={{ width: 110, fontSize: '.78rem', fontWeight: 500, color: 'var(--dim)', textAlign: 'right', flexShrink: 0 }}>
          {f.stage}
        </span>
        <div style={{ flex: 1, background: 'var(--ink4,#f1f5f9)', borderRadius: 6, overflow: 'hidden', height: 26, position: 'relative' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 6, transition: 'width .4s ease' }} />
          <span style={{ position: 'absolute', left: '.6rem', top: '50%', transform: 'translateY(-50%)', fontSize: '.72rem', fontWeight: 600, color: pct > 15 ? '#fff' : 'var(--tx)' }}>
            {f.count} ({f.pct}%)
          </span>
        </div>
      </div>
    );
    if (i < funnel.length - 1) {
      const cur = funnel[i];
      const nxt = funnel[i + 1];
      if (!cur || !nxt) return;
      const drop = cur.count - nxt.count;
      const dropPct = cur.count ? Math.round((drop / cur.count) * 100) : 0;
      if (drop > 0) {
        rows.push(
          <div key={`drop-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.35rem' }}>
            <span style={{ width: 110 }} />
            <span style={{ fontSize: '.68rem', color: '#dc2626', paddingLeft: '.4rem' }}>
              ↓ -{dropPct}% ({drop} dropped)
            </span>
          </div>
        );
      }
    }
  });
  return <>{rows}</>;
}

interface DropoffRowProps {
  item: DropoffItem;
  onRecovered?: () => void;
}

function DropoffRow({ item, onRecovered }: DropoffRowProps) {
  const { showToast } = useToast();
  const [confirming, setConfirming] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [recovered, setRecovered] = useState<boolean>(false);

  const canRecover = (item.stage === 'cart' || item.stage === 'payment_pending') && (item.hours_since_activity || 0) <= 48;
  const icon = STAGE_ICONS[item.stage] || '•';
  const label = STAGE_LABELS[item.stage] || item.stage;
  const cartVal = item.cart_total_rs ? `₹${Math.round(item.cart_total_rs)}` : '—';

  const handleRecover = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = (await recoverDropoff(item.conversation_id)) as RecoverResult | null;
      if (result?.success) {
        setRecovered(true);
        showToast('Recovery message sent!', 'success');
        onRecovered?.();
      } else {
        showToast('Recovery not sent', 'error');
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to send recovery message', 'error');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <tr style={{ borderBottom: '1px solid var(--rim)' }}>
      <td style={{ padding: '.5rem .7rem', fontWeight: 500 }}>{item.customer_name || 'Unknown'}</td>
      <td style={{ padding: '.5rem .7rem', fontFamily: 'monospace', fontSize: '.78rem', color: 'var(--dim)' }}>
        {maskPhone(item.customer_phone)}
      </td>
      <td style={{ padding: '.5rem .7rem', textAlign: 'center' }}>
        <span style={{ fontSize: '.72rem', padding: '.2rem .5rem', borderRadius: 100, background: 'var(--ink4)' }}>
          {icon} {label}
        </span>
      </td>
      <td style={{ padding: '.5rem .7rem', textAlign: 'right', fontWeight: 500 }}>{cartVal}</td>
      <td style={{ padding: '.5rem .7rem', textAlign: 'right', fontSize: '.78rem', color: 'var(--dim)' }}>
        {lastActiveLabel(item.hours_since_activity)}
      </td>
      <td style={{ padding: '.5rem .7rem', textAlign: 'center' }}>
        {recovered ? (
          <span style={{ color: 'var(--wa)', fontSize: '.72rem', fontWeight: 600 }}>✓ Sent</span>
        ) : !canRecover ? (
          <span style={{ color: 'var(--dim)', fontSize: '.72rem' }}>—</span>
        ) : confirming ? (
          <div style={{ display: 'inline-flex', gap: '.25rem' }}>
            <button type="button" className="btn-g btn-sm" onClick={() => setConfirming(false)} disabled={busy} style={{ fontSize: '.7rem', padding: '.2rem .5rem' }}>
              Cancel
            </button>
            <button type="button" className="btn-p btn-sm" onClick={handleRecover} disabled={busy} style={{ fontSize: '.7rem', padding: '.2rem .5rem' }}>
              {busy ? '…' : 'Send'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-p btn-sm"
            onClick={() => setConfirming(true)}
            style={{ fontSize: '.72rem', padding: '.25rem .6rem' }}
          >
            Send Recovery
          </button>
        )}
      </td>
    </tr>
  );
}

interface DropoffsSectionProps { dateRange: DateRange }

export default function DropoffsSection({ dateRange }: DropoffsSectionProps) {
  const days = PRESET_DAYS[dateRange.preset] || 7;
  const { data, loading, error, refetch } = useAnalyticsFetch<DropoffsData | null>(
    useCallback(() => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - days * 86400000).toISOString();
      return getDropoffs({ from, to, limit: 50 }) as Promise<DropoffsData | null>;
    }, [days]),
    [days],
  );

  const summary: DropoffSummary = data?.summary || {};
  const funnel: FunnelStage[] = data?.funnel || [];
  const list: DropoffItem[] = data?.dropoffs || [];
  const recoverable = (summary.dropped_at_cart || 0) + (summary.dropped_at_payment || 0);

  return (
    <>
      <div className="card" style={{ marginTop: '1.2rem' }}>
        <div className="ch"><h3>Customer Drop-off Funnel</h3></div>
        {error ? (
          <div className="cb">
            <SectionError message={error} onRetry={refetch} />
          </div>
        ) : (
          <>
            <div className="stats" id="df-stats">
              <div className="stat">
                <div className="stat-l">Completion Rate</div>
                <div className="stat-v">{summary.completion_rate != null ? `${summary.completion_rate}%` : '—'}</div>
              </div>
              <div className="stat">
                <div className="stat-l">Cart Abandonment</div>
                <div className="stat-v" style={{ color: '#d97706' }}>{summary.dropped_at_cart || 0}</div>
              </div>
              <div className="stat">
                <div className="stat-l">Payment Failures</div>
                <div className="stat-v" style={{ color: '#dc2626' }}>{summary.payment_failed || 0}</div>
              </div>
              <div className="stat">
                <div className="stat-l">Recoverable</div>
                <div className="stat-v" style={{ color: '#2563eb' }}>{recoverable}</div>
              </div>
            </div>
            <div id="df-funnel" style={{ marginTop: '1rem' }}>
              <FunnelBars funnel={funnel} />
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="ch">
          <h3>Incomplete Orders</h3>
          <span style={{ fontSize: '.82rem', color: 'var(--dim)' }}>{list.length} incomplete</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.84rem' }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid var(--rim)' }}>
                <th style={{ padding: '.55rem .7rem', textAlign: 'left', fontSize: '.77rem', fontWeight: 600, color: 'var(--dim)' }}>Customer</th>
                <th style={{ padding: '.55rem .7rem', textAlign: 'left', fontSize: '.77rem', fontWeight: 600, color: 'var(--dim)' }}>Phone</th>
                <th style={{ padding: '.55rem .7rem', textAlign: 'center', fontSize: '.77rem', fontWeight: 600, color: 'var(--dim)' }}>Stage</th>
                <th style={{ padding: '.55rem .7rem', textAlign: 'right', fontSize: '.77rem', fontWeight: 600, color: 'var(--dim)' }}>Cart Value</th>
                <th style={{ padding: '.55rem .7rem', textAlign: 'right', fontSize: '.77rem', fontWeight: 600, color: 'var(--dim)' }}>Last Active</th>
                <th style={{ padding: '.55rem .7rem', textAlign: 'center', fontSize: '.77rem', fontWeight: 600, color: 'var(--dim)' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: 'var(--dim)' }}>Loading…</td></tr>
              ) : list.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: 'var(--dim)' }}>
                  No abandoned sessions in this period
                </td></tr>
              ) : (
                list.map((item) => (
                  <DropoffRow
                    key={item.conversation_id}
                    item={item}
                    onRecovered={refetch}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
