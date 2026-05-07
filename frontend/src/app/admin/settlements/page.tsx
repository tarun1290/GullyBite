'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
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

const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.55rem] px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.3rem] px-[0.6rem] text-[0.78rem]';

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
        <div className="mb-4">
          <SectionError message={statsErr} onRetry={loadStats} />
        </div>
      ) : (
        <>
          <div className="stats mb-4">
            <StatCard label="Total Settlements" value={stats ? (stats.total ?? '—') : '—'} />
            <StatCard label="Pending Payout"    value={stats ? (stats.pending ?? '—') : '—'} />
            <StatCard label="Processing"        value={stats ? (stats.processing ?? '—') : '—'} />
            <StatCard label="Completed"         value={stats ? (stats.completed ?? '—') : '—'} />
            <StatCard label="Failed"            value={stats ? (stats.failed ?? '—') : '—'} />
          </div>
          <div className="stats grid-cols-2 mb-4">
            <StatCard label="Total Payouts"        value={stats ? `₹${fmtCompact(stats.total_payout_rs)}` : '—'} delta="To restaurants" />
            <StatCard label="Platform Fees Earned" value={stats ? `₹${fmtCompact(stats.total_fee_rs)}`    : '—'} delta="Platform revenue" />
          </div>
        </>
      )}

      <div className="mb-4 flex gap-[0.8rem] items-center flex-wrap">
        <button
          type="button"
          className="btn-p btn-sm py-2 px-[1.2rem]"
          onClick={doRun}
          disabled={running}
        >
          {running ? 'Running…' : confirmRun ? 'Confirm — Run Now' : 'Run Settlement Now'}
        </button>
        {confirmRun && (
          <button type="button" className="btn-g btn-sm" onClick={() => setConfirmRun(false)}>Cancel</button>
        )}
        <span className="text-[0.78rem] text-dim">
          Auto-runs every Monday 9:00 AM IST. Use this button for manual runs.
        </span>
      </div>

      <div className="card">
        <div className="ch justify-between flex-wrap gap-2">
          <h3 className="m-0">Settlement History</h3>
          <span className="text-dim text-[0.75rem]">{total} total</span>
          <div className="ml-auto flex gap-2 flex-wrap">
            <input
              value={restaurantId}
              onChange={(e) => { setRestaurantId(e.target.value); setOffset(0); }}
              placeholder="Restaurant ID"
              className={`${INPUT_CLS} w-52`}
            />
            <input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setOffset(0); }} className={INPUT_CLS} title="From" />
            <input type="date" value={toDate}   onChange={(e) => { setToDate(e.target.value);   setOffset(0); }} className={INPUT_CLS} title="To" />
            <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} className={INPUT_CLS}>
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
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Period</th>
                  <th className={TH_CLS}>Orders</th>
                  <th className={TH_CLS}>Gross Revenue</th>
                  <th className={TH_CLS}>Platform Fee</th>
                  <th className={TH_CLS}>Delivery</th>
                  <th className={TH_CLS}>Refunds</th>
                  <th className={TH_CLS}>Meta Cost</th>
                  <th className={TH_CLS}>Net Payout</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Payout ID</th>
                  <th className={TH_CLS}>Created</th>
                  <th className={TH_CLS}></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={13} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={13} className={EMPTY_CLS}>No settlements yet. Click &quot;Run Settlement Now&quot; to generate.</td></tr>
                ) : rows.map((s) => {
                  const badge = STATUS_BADGE[s.payout_status || ''] || { bg: 'var(--ink3)', color: 'var(--dim)', label: s.payout_status || '' };
                  const metaCount = s.meta_message_count || 0;
                  const metaRs = (s.meta_cost_total_paise || 0) / 100;
                  return (
                    <tr key={s.id} className="border-b border-rim">
                      <td className={TD_CLS}>
                        <strong>{s.business_name}</strong>
                        <div className="text-[0.72rem] text-dim mono">
                          {String(s.restaurant_id || '').slice(0, 8)}
                        </div>
                      </td>
                      <td className={`${TD_CLS} text-[0.78rem] whitespace-nowrap`}>
                        {fmtDate(s.period_start)}<br />→ {fmtDate(s.period_end)}
                      </td>
                      <td className={`${TD_CLS} text-center`}>{s.orders_count}</td>
                      <td className={TD_CLS}>₹{fmtCompact(s.gross_revenue_rs)}</td>
                      <td className={`${TD_CLS} text-acc`}>₹{fmtCompact(s.platform_fee_rs)}</td>
                      <td className={TD_CLS}>₹{fmtCompact(s.delivery_costs_rs)}</td>
                      <td className={TD_CLS}>
                        {s.refunds_rs && s.refunds_rs > 0
                          ? <span className="text-red-500">₹{fmtCompact(s.refunds_rs)}</span>
                          : '—'}
                      </td>
                      <td className={TD_CLS}>
                        {metaCount > 0 ? (
                          <button
                            type="button"
                            className="btn-g btn-sm py-[0.2rem] px-2 text-[0.75rem] text-red-600"
                            onClick={() => openBreakdown(s.id)}
                            title={`View ${metaCount} messages`}
                          >
                            ₹{fmtCompact(metaRs)} · {metaCount}
                          </button>
                        ) : <span className="text-dim">—</span>}
                      </td>
                      <td className={TD_CLS}><strong>₹{fmtCompact(s.net_payout_rs)}</strong></td>
                      <td className={TD_CLS}>
                        {/* Dynamic: bg/color come from a runtime palette map keyed by payout_status. */}
                        <span
                          className="inline-block py-[0.15rem] px-[0.55rem] rounded-[10px] font-semibold text-[0.72rem] capitalize"
                          style={{ background: badge.bg, color: badge.color }}
                        >{badge.label}</span>
                      </td>
                      <td className={`${TD_CLS} text-[0.72rem] text-dim mono`}>
                        {s.rp_payout_id ? `${s.rp_payout_id.slice(0, 14)}…` : '—'}
                      </td>
                      <td className={`${TD_CLS} text-dim text-[0.75rem]`}>{fmtTime(s.created_at)}</td>
                      <td className={TD_CLS}>
                        <button
                          type="button"
                          className="btn-g btn-sm py-[0.2rem] px-2 text-[0.75rem]"
                          onClick={() => doDownload(s.id)}
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
          <div className="cb flex gap-[0.6rem] items-center justify-center">
            <button
              type="button"
              className="btn-g btn-sm"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - STL_LIMIT))}
            >
              ← Prev
            </button>
            <span className="text-[0.8rem] text-dim">Page {page} / {pages}</span>
            <button
              type="button"
              className="btn-g btn-sm"
              disabled={offset + STL_LIMIT >= total || loading}
              onClick={() => setOffset(offset + STL_LIMIT)}
            >
              Next →
            </button>
            <span className="text-[0.75rem] text-dim ml-[0.6rem]">
              {total} settlements
            </span>
          </div>
        )}
      </div>

      {breakdown && (
        <div
          onClick={closeBreakdown}
          className="fixed inset-0 bg-black/55 flex items-center justify-center z-1000 p-[1.4rem]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-neutral-0 rounded-[10px] w-[min(960px,100%)] max-h-[86vh] overflow-auto py-[1.2rem] px-[1.4rem] relative"
          >
            <button
              type="button"
              onClick={closeBreakdown}
              className="absolute top-[0.6rem] right-[0.8rem] bg-transparent border-0 text-[1.4rem] cursor-pointer text-dim"
              aria-label="Close"
            >
              ×
            </button>
            <h2 className="m-0 mb-[0.3rem]">Meta Messaging Charges</h2>
            <div className="text-dim text-[0.8rem] mb-[0.8rem]">
              Settlement <span className="mono">{breakdown.id}</span>
              {breakdown.data && (
                <>
                  {' · '}{breakdown.data.meta_message_count || 0} messages{' · '}
                  <strong className="text-red-600">
                    − ₹{((breakdown.data.meta_cost_total_paise || 0) / 100).toFixed(2)}
                  </strong>
                </>
              )}
            </div>
            {breakdownLoading ? (
              <div className="py-4 text-dim">Loading…</div>
            ) : breakdownErr ? (
              <SectionError message={breakdownErr} onRetry={() => openBreakdown(breakdown.id)} />
            ) : (breakdown.data?.items || []).length === 0 ? (
              <div className="text-dim py-4">
                No marketing messages deducted from this settlement.
              </div>
            ) : (
              <table className="w-full text-[0.8rem] border-collapse">
                <thead>
                  <tr className="bg-ink">
                    <th className={TH_CLS}>Restaurant</th>
                    <th className={TH_CLS}>WABA</th>
                    <th className={TH_CLS}>Customer</th>
                    <th className={TH_CLS}>Phone</th>
                    <th className={TH_CLS}>Type</th>
                    <th className={TH_CLS}>Category</th>
                    <th className={TH_CLS}>Cost</th>
                    <th className={TH_CLS}>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {(breakdown.data?.items || []).map((m, i) => (
                    <tr key={m.id || i} className="border-b border-rim">
                      <td className={`${TD_CLS} text-[0.72rem] text-dim mono`}>
                        {String(m.restaurant_id || '').slice(0, 8) || '—'}
                      </td>
                      <td className={`${TD_CLS} text-[0.72rem] text-dim mono`}>
                        {m.waba_id || '—'}
                      </td>
                      <td className={TD_CLS}>{m.customer_name || '—'}</td>
                      <td className={`${TD_CLS} text-dim mono`}>{m.phone || '—'}</td>
                      <td className={TD_CLS}>{m.message_type || '—'}</td>
                      <td className={TD_CLS}>{m.category || '—'}</td>
                      <td className={TD_CLS}>₹{Number(m.cost || 0).toFixed(2)}</td>
                      <td className={`${TD_CLS} text-dim text-[0.75rem]`}>{fmtTime(m.sent_at)}</td>
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
