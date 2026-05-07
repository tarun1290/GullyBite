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
      <p className="text-dim text-center p-4">
        No data for this period
      </p>
    );
  }
  const rows: React.ReactNode[] = [];
  funnel.forEach((f, i) => {
    const pct = Math.max(f.pct, 2);
    const color = FUNNEL_COLORS[i] || '#64748b';
    rows.push(
      <div key={`stage-${i}`} className="flex items-center gap-[0.6rem] mb-[0.35rem]">
        <span className="w-[110px] text-[0.78rem] font-medium text-dim text-right shrink-0">
          {f.stage}
        </span>
        <div className="flex-1 bg-ink4 rounded-md overflow-hidden h-[26px] relative">
          <div
            className="h-full rounded-md transition-[width] duration-400 ease-linear"
            // width is the funnel-stage percentage and background is
            // picked from FUNNEL_COLORS by stage index — both runtime.
            style={{ width: `${pct}%`, background: color }}
          />
          <span
            className={`absolute left-[0.6rem] top-1/2 -translate-y-1/2 text-[0.72rem] font-semibold ${
              pct > 15 ? 'text-white' : 'text-tx'
            }`}
          >
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
          <div key={`drop-${i}`} className="flex items-center gap-[0.6rem] mb-[0.35rem]">
            <span className="w-[110px]" />
            <span className="text-[0.68rem] text-[#dc2626] pl-[0.4rem]">
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
    <tr className="border-b border-rim">
      <td className="py-2 px-[0.7rem] font-medium">{item.customer_name || 'Unknown'}</td>
      <td className="py-2 px-[0.7rem] font-mono text-[0.78rem] text-dim">
        {maskPhone(item.customer_phone)}
      </td>
      <td className="py-2 px-[0.7rem] text-center">
        <span className="text-[0.72rem] py-[0.2rem] px-2 rounded-full bg-ink4">
          {icon} {label}
        </span>
      </td>
      <td className="py-2 px-[0.7rem] text-right font-medium">{cartVal}</td>
      <td className="py-2 px-[0.7rem] text-right text-[0.78rem] text-dim">
        {lastActiveLabel(item.hours_since_activity)}
      </td>
      <td className="py-2 px-[0.7rem] text-center">
        {recovered ? (
          <span className="text-wa text-[0.72rem] font-semibold">✓ Sent</span>
        ) : !canRecover ? (
          <span className="text-dim text-[0.72rem]">—</span>
        ) : confirming ? (
          <div className="inline-flex gap-1">
            <button type="button" className="btn-g btn-sm text-[0.7rem] py-[0.2rem] px-2" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-p btn-sm text-[0.7rem] py-[0.2rem] px-2" onClick={handleRecover} disabled={busy}>
              {busy ? '…' : 'Send'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-p btn-sm text-[0.72rem] py-1 px-[0.6rem]"
            onClick={() => setConfirming(true)}
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
      <div className="card mt-[1.2rem]">
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
                <div className="stat-v text-[#d97706]">{summary.dropped_at_cart || 0}</div>
              </div>
              <div className="stat">
                <div className="stat-l">Payment Failures</div>
                <div className="stat-v text-[#dc2626]">{summary.payment_failed || 0}</div>
              </div>
              <div className="stat">
                <div className="stat-l">Recoverable</div>
                <div className="stat-v text-[#2563eb]">{recoverable}</div>
              </div>
            </div>
            <div id="df-funnel" className="mt-4">
              <FunnelBars funnel={funnel} />
            </div>
          </>
        )}
      </div>

      <div className="card mt-4">
        <div className="ch">
          <h3>Incomplete Orders</h3>
          <span className="text-[0.82rem] text-dim">{list.length} incomplete</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.84rem]">
            <thead>
              <tr className="bg-[#f9fafb] border-b-2 border-rim">
                <th className="py-[0.55rem] px-[0.7rem] text-left text-[0.77rem] font-semibold text-dim">Customer</th>
                <th className="py-[0.55rem] px-[0.7rem] text-left text-[0.77rem] font-semibold text-dim">Phone</th>
                <th className="py-[0.55rem] px-[0.7rem] text-center text-[0.77rem] font-semibold text-dim">Stage</th>
                <th className="py-[0.55rem] px-[0.7rem] text-right text-[0.77rem] font-semibold text-dim">Cart Value</th>
                <th className="py-[0.55rem] px-[0.7rem] text-right text-[0.77rem] font-semibold text-dim">Last Active</th>
                <th className="py-[0.55rem] px-[0.7rem] text-center text-[0.77rem] font-semibold text-dim">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={6} className="text-center p-8 text-dim">Loading…</td></tr>
              ) : list.length === 0 ? (
                <tr><td colSpan={6} className="text-center p-8 text-dim">
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
