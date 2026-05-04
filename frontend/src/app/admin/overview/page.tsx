'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/dashboard/analytics/SectionError';
import { useToast } from '../../../components/Toast';
import {
  getAdminStats,
  getAdminRatingStats,
  getAdminDeliveryStats,
  getAdminAlerts,
  getAdminOrders,
  getAdminLogs,
  getOwnerPushPrefs,
  updateOwnerPushPrefs,
  type OwnerPushPrefs,
} from '../../../api/admin';

interface AdminStats {
  restaurants?: { total?: number; active?: number };
  orders?: { total?: number; today?: number; pending?: number; cancelled?: number };
  revenue?: { total_rs?: number; week_rs?: number };
  customers?: { total?: number; today?: number };
  logs?: { total?: number; unprocessed?: number };
}

interface RatingStats { total?: number; avg_food?: number | string }

interface DeliveryStats {
  total_today?: number;
  active_now?: number;
  avg_delivery_min?: number;
  cost_today_rs?: number;
}

interface AdminAlert {
  severity?: string;
  title?: string;
  message?: string;
  detail?: string;
}

interface OverviewOrder {
  id?: string;
  order_number?: string;
  business_name?: string;
  total_rs?: number;
  status?: string;
}

interface OverviewLog {
  id?: string;
  source?: string;
  event_type?: string;
  processed?: boolean;
  error_message?: string;
  received_at?: string;
}

interface OrdersResponse { orders?: OverviewOrder[] }
interface LogsResponse { logs?: OverviewLog[] }

interface SourceCfg { bg: string; color: string }

const SOURCE_BADGE: Record<string, SourceCfg> = {
  whatsapp: { bg: 'rgba(37,211,102,.18)', color: '#047857' },
  razorpay: { bg: 'rgba(59,130,246,.18)', color: 'var(--gb-blue-600)' },
  '3pl':    { bg: 'rgba(245,158,11,.18)', color: 'var(--gb-amber-600)' },
  catalog:  { bg: 'rgba(139,92,246,.18)', color: '#6d28d9' },
};

function sourceBadge(src?: string) {
  const s = (src || 'other').toLowerCase();
  const cfg = SOURCE_BADGE[s] || { bg: 'rgba(100,116,139,.18)', color: 'var(--gb-slate-700)' };
  return (
    <span style={{
      display: 'inline-block', padding: '.1rem .5rem', borderRadius: 10,
      fontSize: '.72rem', fontWeight: 600, background: cfg.bg, color: cfg.color,
      textTransform: 'uppercase', letterSpacing: '.03em',
    }}>{s}</span>
  );
}

function logStatus(l: OverviewLog) {
  if (l.error_message) return <span style={{ color: 'var(--gb-red-600)', fontSize: '.75rem', fontWeight: 600 }}>Error</span>;
  if (l.processed) return <span style={{ color: '#047857', fontSize: '.75rem', fontWeight: 600 }}>OK</span>;
  return <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>Pending</span>;
}

function orderStatus(s?: string) {
  const st = (s || '').toUpperCase();
  const colorMap: Record<string, string> = {
    DELIVERED: '#047857', CONFIRMED: 'var(--gb-blue-600)', PREPARING: 'var(--gb-amber-600)',
    PACKED: '#6d28d9', DISPATCHED: '#0891b2', CANCELLED: 'var(--gb-red-600)',
    PAID: '#047857', PENDING_PAYMENT: 'var(--gb-slate-500)', PAYMENT_FAILED: 'var(--gb-red-500)',
  };
  const color = colorMap[st] || 'var(--gb-slate-700)';
  return <span style={{ color, fontSize: '.75rem', fontWeight: 600 }}>{st || '—'}</span>;
}

function timeAgo(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtNum(n: number | string | null | undefined): string {
  return n == null ? '—' : Number(n).toLocaleString('en-IN');
}

const th: CSSProperties = { padding: '.5rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.5rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };

export default function AdminOverviewPage() {
  const { showToast } = useToast();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [rating, setRating] = useState<RatingStats | null>(null);
  const [delivery, setDelivery] = useState<DeliveryStats | null>(null);
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);
  const [orders, setOrders] = useState<OverviewOrder[]>([]);
  const [logs, setLogs] = useState<OverviewLog[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  // Owner Push Alerts — platform-level prefs. Toggles save immediately
  // (no Save button) so we track per-key in-flight state to disable the
  // affected row while the PATCH is round-tripping. On error we revert
  // the local optimistic flip; on success we trust the server-returned
  // prefs payload as the new ground truth.
  const [ownerPrefs, setOwnerPrefs] = useState<OwnerPushPrefs | null>(null);
  const [ownerPrefsLoading, setOwnerPrefsLoading] = useState<boolean>(true);
  const [ownerPrefsSavingKey, setOwnerPrefsSavingKey] = useState<keyof OwnerPushPrefs | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, o, l] = await Promise.all([
        getAdminStats() as Promise<AdminStats | null>,
        getAdminOrders({ limit: 8 }) as Promise<OrdersResponse | null>,
        getAdminLogs({ limit: 8 }) as Promise<LogsResponse | null>,
      ]);
      setStats(s);
      setOrders(o?.orders || []);
      setLogs(l?.logs || []);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed to load overview');
    } finally {
      setLoading(false);
    }
    try { setRating((await getAdminRatingStats()) as RatingStats | null); } catch { /* non-fatal */ }
    try { setDelivery((await getAdminDeliveryStats()) as DeliveryStats | null); } catch { /* non-fatal */ }
    try { setAlerts(((await getAdminAlerts()) as AdminAlert[] | null) || []); } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  // One-shot load for owner push prefs. Independent of the main `load`
  // so a stats failure doesn't block the toggles from rendering, and
  // vice versa. Errors here surface as a toast — the section will
  // simply not render its toggle rows when prefs is null.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getOwnerPushPrefs();
        if (!cancelled) setOwnerPrefs(r.prefs);
      } catch (e: unknown) {
        const er = e as { response?: { data?: { error?: string } }; message?: string };
        showToast(er?.response?.data?.error || er?.message || 'Failed to load owner push prefs', 'error');
      } finally {
        if (!cancelled) setOwnerPrefsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showToast]);

  const onTogglePref = useCallback(async (key: keyof OwnerPushPrefs, next: boolean) => {
    if (!ownerPrefs) return;
    const prev = ownerPrefs[key];
    setOwnerPrefs({ ...ownerPrefs, [key]: next });
    setOwnerPrefsSavingKey(key);
    try {
      const r = await updateOwnerPushPrefs({ [key]: next });
      // Server is source of truth — it returns the resolved prefs after upsert.
      if (r?.prefs) setOwnerPrefs(r.prefs);
      showToast('Owner push preference saved', 'success');
    } catch (e: unknown) {
      // Revert the optimistic flip so the UI matches the server state again.
      setOwnerPrefs((cur) => (cur ? { ...cur, [key]: prev } : cur));
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Save failed', 'error');
    } finally {
      setOwnerPrefsSavingKey(null);
    }
  }, [ownerPrefs, showToast]);

  const s: AdminStats = stats || {};
  const r: RatingStats = rating || {};
  const ds: DeliveryStats = delivery || {};

  const restTotal = s.restaurants?.total;
  const restActive = s.restaurants?.active;
  const ordTotal = s.orders?.total;
  const ordToday = s.orders?.today;
  const ordPending = s.orders?.pending;
  const ordCancelled = s.orders?.cancelled;
  const revTotal = s.revenue?.total_rs;
  const revWeek = s.revenue?.week_rs;
  const custTotal = s.customers?.total;
  const custToday = s.customers?.today;
  const logsTotal = s.logs?.total;
  const logsUnproc = s.logs?.unprocessed;

  const ratingVal = r.total ? `${r.avg_food} ⭐` : '—';
  const ratingSub = r.total != null ? `${fmtNum(r.total)} reviews` : '';

  const delivTotal = ds.total_today;
  const delivSub = ds.total_today != null
    ? `${fmtNum(ds.active_now)} active · ${ds.avg_delivery_min || 0}m avg · ₹${fmtNum(ds.cost_today_rs)} cost`
    : '';

  return (
    <div id="pg-overview">
      {alerts.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          {alerts.map((a, i) => {
            const crit = a.severity === 'critical';
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: '.7rem',
                padding: '.65rem 1rem',
                background: crit ? '#fef2f2' : '#fffbeb',
                border: `1px solid ${crit ? 'var(--gb-red-200)' : '#fde68a'}`,
                color: crit ? 'var(--gb-red-500)' : 'var(--gb-amber-500)',
                borderRadius: 8, marginBottom: '.5rem', fontSize: '.84rem',
              }}>
                <span>{crit ? '🔴' : '⚠️'}</span>
                <span style={{ fontWeight: 600 }}>{a.title || a.message || 'Alert'}</span>
                {a.detail && <span style={{ color: 'var(--dim)' }}>{a.detail}</span>}
              </div>
            );
          })}
        </div>
      )}

      {err ? (
        <div style={{ marginBottom: '1rem' }}><SectionError message={err} onRetry={load} /></div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: '.6rem',
              marginBottom: '1.2rem',
            }}
          >
            <StatCard label="Restaurants" value={loading ? '…' : fmtNum(restTotal)}
              delta={restActive != null ? `${fmtNum(restActive)} active` : null} />
            <StatCard label="Total Orders" value={loading ? '…' : fmtNum(ordTotal)}
              delta={ordToday != null ? `${fmtNum(ordToday)} today` : null} />
            <StatCard label="Total Revenue"
              value={loading ? '…' : (revTotal != null ? `₹${fmtNum(revTotal)}` : '—')}
              delta={revWeek != null ? `₹${fmtNum(revWeek)} this week` : null} />
            <StatCard label="Customers" value={loading ? '…' : fmtNum(custTotal)}
              delta={custToday != null ? `${fmtNum(custToday)} today` : null} />
            <StatCard label="Webhook Logs" value={loading ? '…' : fmtNum(logsTotal)}
              delta={logsUnproc != null ? `${fmtNum(logsUnproc)} unprocessed` : null} />
            <StatCard label="Pending Orders" value={loading ? '…' : fmtNum(ordPending)}
              delta={ordCancelled != null ? `${fmtNum(ordCancelled)} cancelled` : null} />
            <StatCard label="Avg Rating" value={loading ? '…' : ratingVal} delta={ratingSub || null} />
            <StatCard label="Deliveries Today"
              value={loading ? '…' : (delivTotal != null ? fmtNum(delivTotal) : '—')}
              delta={delivSub || null} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '1rem' }}>
            <div className="card">
              <div className="ch" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0, fontSize: '.9rem' }}>Recent Orders</h3>
                <Link href="/admin/orders" className="btn-g btn-sm">View All</Link>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                      <th style={th}>Order</th>
                      <th style={th}>Restaurant</th>
                      <th style={th}>Amount</th>
                      <th style={th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={4} style={emptyCell}>Loading…</td></tr>
                    ) : orders.length === 0 ? (
                      <tr><td colSpan={4} style={emptyCell}>No orders yet</td></tr>
                    ) : orders.map((o) => (
                      <tr key={o.id || o.order_number} style={{ borderTop: '1px solid var(--rim)' }}>
                        <td style={{ ...td, fontFamily: 'monospace' }}>#{o.order_number}</td>
                        <td style={{ ...td, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{o.business_name || '—'}</td>
                        <td style={td}>{o.total_rs != null ? `₹${o.total_rs}` : '—'}</td>
                        <td style={td}>{orderStatus(o.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="ch" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0, fontSize: '.9rem' }}>Recent Logs</h3>
                <Link href="/admin/logs" className="btn-g btn-sm">View All</Link>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                      <th style={th}>Source</th>
                      <th style={th}>Event</th>
                      <th style={th}>Status</th>
                      <th style={th}>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={4} style={emptyCell}>Loading…</td></tr>
                    ) : logs.length === 0 ? (
                      <tr><td colSpan={4} style={emptyCell}>No logs yet</td></tr>
                    ) : logs.map((l) => (
                      <tr key={l.id} style={{ borderTop: '1px solid var(--rim)' }}>
                        <td style={td}>{sourceBadge(l.source)}</td>
                        <td style={{ ...td, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{l.event_type || '—'}</td>
                        <td style={td}>{logStatus(l)}</td>
                        <td style={{ ...td, color: 'var(--dim)' }}>{timeAgo(l.received_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <OwnerPushAlertsCard
            prefs={ownerPrefs}
            loading={ownerPrefsLoading}
            savingKey={ownerPrefsSavingKey}
            onToggle={onTogglePref}
          />
        </>
      )}
    </div>
  );
}

// ─── Owner Push Alerts ───────────────────────────────────────────
// Platform-level toggles for the four owner-mobile push channels:
// new_order, settlement_paid, branch_paused, daily_summary. Each
// row saves immediately on change — there's no "Save" button. The
// gating logic on the backend (services/expoPush.js getOwnerPushPrefs)
// is fail-open, so muting a channel via this UI is the only way to
// stop those pushes platform-wide.

interface OwnerPushAlertsCardProps {
  prefs: OwnerPushPrefs | null;
  loading: boolean;
  savingKey: keyof OwnerPushPrefs | null;
  onToggle: (key: keyof OwnerPushPrefs, next: boolean) => Promise<void>;
}

const OWNER_PUSH_ROWS: ReadonlyArray<{ key: keyof OwnerPushPrefs; label: string; description: string }> = [
  { key: 'new_order',       label: 'New Orders',         description: 'Alert owners when any branch receives an order' },
  { key: 'settlement_paid', label: 'Settlement Payouts', description: 'Alert when a payout is credited to bank' },
  { key: 'branch_paused',   label: 'Branch Paused',      description: 'Alert when a branch is auto-paused due to low balance' },
  { key: 'daily_summary',   label: 'Daily Summary',      description: 'Send 11pm summary of orders and revenue' },
];

function OwnerPushAlertsCard({ prefs, loading, savingKey, onToggle }: OwnerPushAlertsCardProps) {
  return (
    <div className="card" style={{ marginTop: '1.2rem' }}>
      <div className="ch">
        <h3 style={{ margin: 0, fontSize: '.9rem' }}>🔔 Owner Push Alerts</h3>
      </div>
      <div className="cb">
        {loading ? (
          <div style={{ color: 'var(--dim)', fontSize: '.84rem' }}>Loading…</div>
        ) : !prefs ? (
          <div style={{ color: 'var(--dim)', fontSize: '.84rem' }}>Unable to load preferences.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {OWNER_PUSH_ROWS.map((row, i) => {
              const checked = prefs[row.key];
              const busy = savingKey === row.key;
              return (
                <label
                  key={row.key}
                  htmlFor={`owner-push-${row.key}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    padding: '.75rem 0',
                    borderTop: i === 0 ? 'none' : '1px solid var(--rim)',
                    cursor: busy ? 'default' : 'pointer',
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '.86rem', fontWeight: 600, color: 'var(--tx,inherit)' }}>
                      {row.label}
                    </div>
                    <div style={{ fontSize: '.76rem', color: 'var(--dim)', marginTop: '.15rem' }}>
                      {row.description}
                    </div>
                  </div>
                  <input
                    id={`owner-push-${row.key}`}
                    type="checkbox"
                    role="switch"
                    checked={checked}
                    disabled={busy}
                    onChange={(e) => { void onToggle(row.key, e.target.checked); }}
                    style={{ width: 18, height: 18, cursor: busy ? 'default' : 'pointer' }}
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
