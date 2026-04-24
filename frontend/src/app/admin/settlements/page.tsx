'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/dashboard/analytics/SectionError';
import {
  getSettlementStats,
  getSettlements,
  getSettlementMetaBreakdown,
  downloadSettlementBlob,
  runSettlement,
} from '../../../api/admin';

const STL_LIMIT = 50;

interface BadgeMeta { bg: string; color: string; label: string }

const STATUS_BADGE: Record<string, BadgeMeta> = {
  pending:    { bg: 'rgba(245,158,11,.16)',  color: 'var(--gb-amber-600)', label: 'Pending' },
  processing: { bg: 'rgba(59,130,246,.16)',  color: 'var(--gb-blue-500)', label: 'Processing' },
  completed:  { bg: 'rgba(34,197,94,.16)',   color: '#047857', label: 'Completed' },
  failed:     { bg: 'rgba(239,68,68,.18)',   color: 'var(--gb-red-600)', label: 'Failed' },
};

interface AdminSettlementStats {
  total?: number;
  pending?: number;
  processing?: number;
  completed?: number;
  failed?: number;
  total_payout_rs?: number | string;
  total_fee_rs?: number | string;
}

interface SettlementRow {
  id: string;
  business_name?: string;
  restaurant_id?: string;
  period_start?: string;
  period_end?: string;
  orders_count?: number;
  gross_revenue_rs?: number | string;
  platform_fee_rs?: number | string;
  delivery_costs_rs?: number | string;
  refunds_rs?: number;
  meta_message_count?: number;
  meta_cost_total_paise?: number;
  net_payout_rs?: number | string;
  payout_status?: string;
  rp_payout_id?: string;
  created_at?: string;
}

interface SettlementsResponse {
  settlements?: SettlementRow[];
  total?: number;
}

interface MetaItem {
  id?: string;
  restaurant_id?: string;
  waba_id?: string;
  customer_name?: string;
  phone?: string;
  message_type?: string;
  category?: string;
  cost?: number;
  sent_at?: string;
}

interface MetaBreakdownData {
  meta_message_count?: number;
  meta_cost_total_paise?: number;
  items?: MetaItem[];
}

interface BreakdownState {
  id: string;
  data: MetaBreakdownData | null;
}

function fmtCompact(n: number | string | null | undefined): string {
  const v = parseFloat(String(n)) || 0;
  if (v >= 1e7) return (v / 1e7).toFixed(1) + 'Cr';
  if (v >= 1e5) return (v / 1e5).toFixed(1) + 'L';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(2);
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
  } catch { return '—'; }
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

const th: CSSProperties = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.55rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input: CSSProperties = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.3rem .6rem', fontSize: '.78rem' };

export default function AdminSettlementsPage() {
  const { showToast } = useToast();
  const [stats, setStats] = useState<AdminSettlementStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [listErr, setListErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [offset, setOffset] = useState<number>(0);
  const [running, setRunning] = useState<boolean>(false);
  const [confirmRun, setConfirmRun] = useState<boolean>(false);

  const [restaurantId, setRestaurantId] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [status, setStatus] = useState<string>('');

  const [breakdown, setBreakdown] = useState<BreakdownState | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState<boolean>(false);
  const [breakdownErr, setBreakdownErr] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const s = (await getSettlementStats()) as AdminSettlementStats | null;
      setStats(s);
      setStatsErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setStatsErr(er?.response?.data?.error || er?.message || 'Failed to load stats');
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string | number> = { limit: STL_LIMIT, offset };
    if (status) params.status = status;
    if (restaurantId.trim()) params.restaurant_id = restaurantId.trim();
    if (fromDate) params.from = fromDate;
    if (toDate) params.to = toDate;
    try {
      const d = (await getSettlements(params)) as SettlementsResponse | null;
      setRows(Array.isArray(d?.settlements) ? d.settlements : []);
      setTotal(d?.total || 0);
      setListErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setTotal(0);
      setListErr(er?.response?.data?.error || er?.message || 'Failed to load settlements');
    } finally {
      setLoading(false);
    }
  }, [offset, status, restaurantId, fromDate, toDate]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadList(); }, [loadList]);

  const page = Math.floor(offset / STL_LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(total / STL_LIMIT));

  const doRun = async () => {
    if (!confirmRun) { setConfirmRun(true); return; }
    setConfirmRun(false);
    setRunning(true);
    try {
      await runSettlement();
      showToast('Settlement started — refresh in a few seconds', 'success');
      setTimeout(() => { loadStats(); loadList(); }, 3000);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Run failed', 'error');
    } finally {
      setRunning(false);
    }
  };

  const doDownload = async (id: string) => {
    try {
      const { blob, headers } = await downloadSettlementBlob(id);
      const cd = (headers as Record<string, string | undefined>)?.['content-disposition'] || '';
      const match = /filename="([^"]+)"/.exec(cd);
      const filename = match?.[1] || `settlement_${id}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Download failed', 'error');
    }
  };

  const openBreakdown = async (id: string) => {
    setBreakdown({ id, data: null });
    setBreakdownLoading(true);
    setBreakdownErr(null);
    try {
      const d = (await getSettlementMetaBreakdown(id)) as MetaBreakdownData | null;
      setBreakdown({ id, data: d });
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setBreakdownErr(er?.response?.data?.error || er?.message || 'Failed to load breakdown');
    } finally {
      setBreakdownLoading(false);
    }
  };

  const closeBreakdown = () => {
    setBreakdown(null);
    setBreakdownErr(null);
  };

  return (
    <div id="pg-settlements">
      {statsErr ? (
        <div style={{ marginBottom: '1rem' }}>
          <SectionError message={statsErr} onRetry={loadStats} />
        </div>
      ) : (
        <>
          <div className="stats" style={{ marginBottom: '1rem' }}>
            <StatCard label="Total Settlements" value={stats ? (stats.total ?? '—') : '—'} />
            <StatCard label="Pending Payout"    value={stats ? (stats.pending ?? '—') : '—'} />
            <StatCard label="Processing"        value={stats ? (stats.processing ?? '—') : '—'} />
            <StatCard label="Completed"         value={stats ? (stats.completed ?? '—') : '—'} />
            <StatCard label="Failed"            value={stats ? (stats.failed ?? '—') : '—'} />
          </div>
          <div className="stats" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: '1rem' }}>
            <StatCard label="Total Payouts"        value={stats ? `₹${fmtCompact(stats.total_payout_rs)}` : '—'} delta="To restaurants" />
            <StatCard label="Platform Fees Earned" value={stats ? `₹${fmtCompact(stats.total_fee_rs)}`    : '—'} delta="Platform revenue" />
          </div>
        </>
      )}

      <div style={{ marginBottom: '1rem', display: 'flex', gap: '.8rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-p btn-sm"
          onClick={doRun}
          disabled={running}
          style={{ padding: '.5rem 1.2rem' }}
        >
          {running ? 'Running…' : confirmRun ? 'Confirm — Run Now' : 'Run Settlement Now'}
        </button>
        {confirmRun && (
          <button type="button" className="btn-g btn-sm" onClick={() => setConfirmRun(false)}>Cancel</button>
        )}
        <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
          Auto-runs every Monday 9:00 AM IST. Use this button for manual runs.
        </span>
      </div>

      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '.5rem' }}>
          <h3 style={{ margin: 0 }}>Settlement History</h3>
          <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>{total} total</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
            <input
              value={restaurantId}
              onChange={(e) => { setRestaurantId(e.target.value); setOffset(0); }}
              placeholder="Restaurant ID"
              style={{ ...input, width: '13rem' }}
            />
            <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setOffset(0); }} style={input} title="From" />
            <input type="date" value={toDate}   onChange={(e) => { setToDate(e.target.value);   setOffset(0); }} style={input} title="To" />
            <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} style={input}>
              <option value="">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
            <button type="button" className="btn-g btn-sm" onClick={loadList} disabled={loading}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
        </div>
        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadList} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', borderBottom: '1px solid var(--rim)' }}>
                  <th style={th}>Restaurant</th>
                  <th style={th}>Period</th>
                  <th style={th}>Orders</th>
                  <th style={th}>Gross Revenue</th>
                  <th style={th}>Platform Fee</th>
                  <th style={th}>Delivery</th>
                  <th style={th}>Refunds</th>
                  <th style={th}>Meta Cost</th>
                  <th style={th}>Net Payout</th>
                  <th style={th}>Status</th>
                  <th style={th}>Payout ID</th>
                  <th style={th}>Created</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={13} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={13} style={emptyCell}>No settlements yet. Click &quot;Run Settlement Now&quot; to generate.</td></tr>
                ) : rows.map((s) => {
                  const badge = STATUS_BADGE[s.payout_status || ''] || { bg: 'var(--ink3)', color: 'var(--dim)', label: s.payout_status || '' };
                  const metaCount = s.meta_message_count || 0;
                  const metaRs = (s.meta_cost_total_paise || 0) / 100;
                  return (
                    <tr key={s.id} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td style={td}>
                        <strong>{s.business_name}</strong>
                        <div style={{ fontSize: '.72rem', color: 'var(--dim)' }} className="mono">
                          {String(s.restaurant_id || '').slice(0, 8)}
                        </div>
                      </td>
                      <td style={{ ...td, fontSize: '.78rem', whiteSpace: 'nowrap' }}>
                        {fmtDate(s.period_start)}<br />→ {fmtDate(s.period_end)}
                      </td>
                      <td style={{ ...td, textAlign: 'center' }}>{s.orders_count}</td>
                      <td style={td}>₹{fmtCompact(s.gross_revenue_rs)}</td>
                      <td style={{ ...td, color: 'var(--acc)' }}>₹{fmtCompact(s.platform_fee_rs)}</td>
                      <td style={td}>₹{fmtCompact(s.delivery_costs_rs)}</td>
                      <td style={td}>
                        {s.refunds_rs && s.refunds_rs > 0
                          ? <span style={{ color: 'var(--gb-red-500)' }}>₹{fmtCompact(s.refunds_rs)}</span>
                          : '—'}
                      </td>
                      <td style={td}>
                        {metaCount > 0 ? (
                          <button
                            type="button"
                            className="btn-g btn-sm"
                            onClick={() => openBreakdown(s.id)}
                            title={`View ${metaCount} messages`}
                            style={{ padding: '.2rem .5rem', fontSize: '.75rem', color: 'var(--gb-red-600)' }}
                          >
                            ₹{fmtCompact(metaRs)} · {metaCount}
                          </button>
                        ) : <span style={{ color: 'var(--dim)' }}>—</span>}
                      </td>
                      <td style={td}><strong>₹{fmtCompact(s.net_payout_rs)}</strong></td>
                      <td style={td}>
                        <span style={{
                          display: 'inline-block',
                          padding: '.15rem .55rem',
                          borderRadius: 10,
                          background: badge.bg,
                          color: badge.color,
                          fontWeight: 600,
                          fontSize: '.72rem',
                          textTransform: 'capitalize',
                        }}>{badge.label}</span>
                      </td>
                      <td style={{ ...td, fontSize: '.72rem', color: 'var(--dim)' }} className="mono">
                        {s.rp_payout_id ? `${s.rp_payout_id.slice(0, 14)}…` : '—'}
                      </td>
                      <td style={{ ...td, color: 'var(--dim)', fontSize: '.75rem' }}>{fmtTime(s.created_at)}</td>
                      <td style={td}>
                        <button
                          type="button"
                          className="btn-g btn-sm"
                          onClick={() => doDownload(s.id)}
                          style={{ padding: '.2rem .5rem', fontSize: '.75rem' }}
                          title="Download Excel"
                        >
                          Excel
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {total > 0 && (
          <div className="cb" style={{ display: 'flex', gap: '.6rem', alignItems: 'center', justifyContent: 'center' }}>
            <button
              type="button"
              className="btn-g btn-sm"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - STL_LIMIT))}
            >
              ← Prev
            </button>
            <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>Page {page} / {pages}</span>
            <button
              type="button"
              className="btn-g btn-sm"
              disabled={offset + STL_LIMIT >= total || loading}
              onClick={() => setOffset(offset + STL_LIMIT)}
            >
              Next →
            </button>
            <span style={{ fontSize: '.75rem', color: 'var(--dim)', marginLeft: '.6rem' }}>
              {total} settlements
            </span>
          </div>
        )}
      </div>

      {breakdown && (
        <div
          onClick={closeBreakdown}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1.4rem',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--gb-neutral-0)', borderRadius: 10, width: 'min(960px, 100%)',
              maxHeight: '86vh', overflow: 'auto', padding: '1.2rem 1.4rem', position: 'relative',
            }}
          >
            <button
              type="button"
              onClick={closeBreakdown}
              style={{
                position: 'absolute', top: '.6rem', right: '.8rem', background: 'transparent',
                border: 0, fontSize: '1.4rem', cursor: 'pointer', color: 'var(--dim)',
              }}
              aria-label="Close"
            >
              ×
            </button>
            <h2 style={{ margin: '0 0 .3rem 0' }}>Meta Messaging Charges</h2>
            <div style={{ color: 'var(--dim)', fontSize: '.8rem', marginBottom: '.8rem' }}>
              Settlement <span className="mono">{breakdown.id}</span>
              {breakdown.data && (
                <>
                  {' · '}{breakdown.data.meta_message_count || 0} messages{' · '}
                  <strong style={{ color: 'var(--gb-red-600)' }}>
                    − ₹{((breakdown.data.meta_cost_total_paise || 0) / 100).toFixed(2)}
                  </strong>
                </>
              )}
            </div>
            {breakdownLoading ? (
              <div style={{ padding: '1rem 0', color: 'var(--dim)' }}>Loading…</div>
            ) : breakdownErr ? (
              <SectionError message={breakdownErr} onRetry={() => openBreakdown(breakdown.id)} />
            ) : (breakdown.data?.items || []).length === 0 ? (
              <div style={{ color: 'var(--dim)', padding: '1rem 0' }}>
                No marketing messages deducted from this settlement.
              </div>
            ) : (
              <table style={{ width: '100%', fontSize: '.8rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--ink)' }}>
                    <th style={th}>Restaurant</th>
                    <th style={th}>WABA</th>
                    <th style={th}>Customer</th>
                    <th style={th}>Phone</th>
                    <th style={th}>Type</th>
                    <th style={th}>Category</th>
                    <th style={th}>Cost</th>
                    <th style={th}>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {(breakdown.data?.items || []).map((m, i) => (
                    <tr key={m.id || i} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td style={{ ...td, fontSize: '.72rem', color: 'var(--dim)' }} className="mono">
                        {String(m.restaurant_id || '').slice(0, 8) || '—'}
                      </td>
                      <td style={{ ...td, fontSize: '.72rem', color: 'var(--dim)' }} className="mono">
                        {m.waba_id || '—'}
                      </td>
                      <td style={td}>{m.customer_name || '—'}</td>
                      <td style={{ ...td, color: 'var(--dim)' }} className="mono">{m.phone || '—'}</td>
                      <td style={td}>{m.message_type || '—'}</td>
                      <td style={td}>{m.category || '—'}</td>
                      <td style={td}>₹{Number(m.cost || 0).toFixed(2)}</td>
                      <td style={{ ...td, color: 'var(--dim)', fontSize: '.75rem' }}>{fmtTime(m.sent_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
