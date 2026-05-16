'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getSettlementStats,
  getSettlements,
  getSettlementMetaBreakdown,
  downloadSettlementBlob,
  confirmSettlementPayout,
} from '../../../api/admin';

const STL_LIMIT = 50;

// Phase 5 rows carry `status`; legacy rows carry `payout_status`.
// Normalize once so the badge + filters work across both shapes.
function normStatus(s: SettlementRow): string {
  return String(s.status || s.payout_status || '').toLowerCase();
}

// status → Tailwind badge classes (replaces the prior runtime inline-style
// palette map — the status set is finite so static classes are fine).
const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  pending_manual_payout: { cls: 'bg-amber-100 text-amber-800', label: 'Pending Payout' },
  pending:               { cls: 'bg-amber-100 text-amber-800', label: 'Pending' },
  processing:            { cls: 'bg-blue-100 text-blue-800',   label: 'Processing' },
  completed:             { cls: 'bg-green-100 text-green-800', label: 'Completed' },
  failed:                { cls: 'bg-red-100 text-red-800',     label: 'Failed' },
};

// Top filter buckets. Default = Pending Payout (the manual-transfer queue).
const STATUS_FILTERS = [
  { key: 'pending', label: 'Pending Payout' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'all', label: 'All' },
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number]['key'];

function matchesStatusFilter(s: SettlementRow, f: StatusFilter): boolean {
  if (f === 'all') return true;
  const st = normStatus(s);
  if (f === 'pending') return st === 'pending_manual_payout';
  if (f === 'completed') return st === 'completed';
  if (f === 'failed') return st === 'failed';
  return true;
}

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
  platform_fee_paise?: number;
  platform_fee_gst_paise?: number;
  platform_fee_branch_count?: number;
  tds_amount_rs?: number | string;
  delivery_costs_rs?: number | string;
  refunds_rs?: number;
  meta_message_count?: number;
  meta_cost_total_paise?: number;
  net_payout_rs?: number | string;
  status?: string;
  payout_status?: string;
  payout_id?: string;
  rp_payout_id?: string;
  settlement_type?: string;
  created_at?: string;
  // Backend-enriched (GET /api/admin/settlements). null when the
  // restaurant has no transferable bank account on record.
  restaurant_bank_details?: {
    account_holder_name?: string | null;
    account_number?: string;
    ifsc?: string;
    bank_name?: string | null;
  } | null;
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

interface MarkPaidState {
  payoutId: string;
  label: string; // restaurant + amount, for the modal header
  utr: string;
  notes: string;
  submitting: boolean;
  error: string | null;
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

// IST calendar date (YYYY-MM-DD) for the date-range presets. The backend
// parses from/to as date strings (created_at $gte from / $lt to+1d), so
// IST calendar boundaries are what we feed it. (Minor: the backend treats
// these as UTC-midnight — inherent to its existing from/to handling, not
// changed here; display filter only.)
function istParts(d: Date): { y: number; m: number; day: number; dow: number } {
  const s = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), day: s.getUTCDate(), dow: s.getUTCDay() };
}
function ymd(y: number, m: number, day: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
type DatePreset = 'this_week' | 'last_2_weeks' | 'this_month' | 'last_month' | 'custom';
function presetRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const { y, m, day, dow } = istParts(now);
  const todayUTC = Date.UTC(y, m, day);
  const toStr = ymd(y, m, day);
  if (preset === 'this_week') {
    // Monday-anchored: dow 0=Sun..6=Sat → days since Monday.
    const sinceMon = (dow + 6) % 7;
    const mon = new Date(todayUTC - sinceMon * 86400000);
    return { from: ymd(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate()), to: toStr };
  }
  if (preset === 'last_2_weeks') {
    const start = new Date(todayUTC - 14 * 86400000);
    return { from: ymd(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()), to: toStr };
  }
  if (preset === 'this_month') {
    return { from: ymd(y, m, 1), to: toStr };
  }
  // last_month
  const lm = m === 0 ? 11 : m - 1;
  const lmy = m === 0 ? y - 1 : y;
  const lastDay = new Date(Date.UTC(lmy, lm + 1, 0)).getUTCDate();
  return { from: ymd(lmy, lm, 1), to: ymd(lmy, lm, lastDay) };
}

const TH_CLS = 'py-2.5 px-3 text-left text-xs text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-3 align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-1 px-2.5 text-sm';

export default function AdminSettlementsPage() {
  const { showToast } = useToast();
  const [stats, setStats] = useState<AdminSettlementStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [listErr, setListErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [offset, setOffset] = useState<number>(0);

  const [restaurantId, setRestaurantId] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [datePreset, setDatePreset] = useState<DatePreset>('this_month');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');

  const [breakdown, setBreakdown] = useState<BreakdownState | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState<boolean>(false);
  const [breakdownErr, setBreakdownErr] = useState<string | null>(null);

  const [markPaid, setMarkPaid] = useState<MarkPaidState | null>(null);

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

  // Date range is server-side (created_at from/to — works for both row
  // shapes). Status filtering is CLIENT-side: the backend `status` query
  // param filters legacy `payout_status`, which Phase 5 rows don't carry.
  const loadList = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string | number> = { limit: STL_LIMIT, offset };
    if (restaurantId.trim()) params.restaurant_id = restaurantId.trim();
    if (datePreset === 'custom') {
      if (customFrom) params.from = customFrom;
      if (customTo) params.to = customTo;
    } else {
      const { from, to } = presetRange(datePreset);
      params.from = from;
      params.to = to;
    }
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
  }, [offset, restaurantId, datePreset, customFrom, customTo]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadList(); }, [loadList]);

  const page = Math.floor(offset / STL_LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(total / STL_LIMIT));

  // Apply the client-side status filter, then group by restaurant
  // preserving the backend's created_at-desc order within each group.
  const grouped = useMemo(() => {
    const filtered = rows.filter((s) => matchesStatusFilter(s, statusFilter));
    const order: string[] = [];
    const map = new Map<string, { name: string; rid: string; bank: SettlementRow['restaurant_bank_details']; items: SettlementRow[] }>();
    for (const s of filtered) {
      const rid = String(s.restaurant_id || 'unknown');
      if (!map.has(rid)) {
        map.set(rid, { name: s.business_name || '—', rid, bank: s.restaurant_bank_details ?? null, items: [] });
        order.push(rid);
      }
      map.get(rid)!.items.push(s);
    }
    return order.map((rid) => map.get(rid)!);
  }, [rows, statusFilter]);

  const filteredCount = useMemo(
    () => rows.filter((s) => matchesStatusFilter(s, statusFilter)).length,
    [rows, statusFilter],
  );

  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast(`Copied ${label}`, 'success');
    } catch {
      showToast('Copy failed', 'error');
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

  const submitMarkPaid = async () => {
    if (!markPaid) return;
    const utr = markPaid.utr.trim();
    if (!utr) {
      setMarkPaid({ ...markPaid, error: 'UTR is required' });
      return;
    }
    setMarkPaid({ ...markPaid, submitting: true, error: null });
    try {
      await confirmSettlementPayout(markPaid.payoutId, utr);
      setMarkPaid(null);
      showToast('Settlement marked paid', 'success');
      loadStats();
      loadList();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setMarkPaid((prev) => prev && ({
        ...prev,
        submitting: false,
        error: er?.response?.data?.error || er?.message || 'Mark-paid failed',
      }));
    }
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

      <div className="mb-4 flex gap-3 items-center flex-wrap">
        <span className="text-sm text-dim">
          Settlements run automatically every Monday &amp; Thursday at 06:00 AM IST.
          Per-restaurant manual runs are available via the admin API.
        </span>
      </div>

      <div className="card">
        <div className="ch justify-between flex-wrap gap-2">
          <h3 className="m-0">Settlement History</h3>
          <span className="text-dim text-xs">{filteredCount} shown · {total} total</span>
          <div className="ml-auto flex gap-2 flex-wrap items-center">
            {/* Status filter — client-side (see loadList note) */}
            <div className="flex gap-1">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`btn-sm py-1 px-3 rounded-md text-xs ${statusFilter === f.key ? 'btn-p' : 'btn-g'}`}
                  onClick={() => setStatusFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <input
              value={restaurantId}
              onChange={(e) => { setRestaurantId(e.target.value); setOffset(0); }}
              placeholder="Restaurant ID"
              className={`${INPUT_CLS} w-44`}
            />
            <select
              value={datePreset}
              onChange={(e) => { setDatePreset(e.target.value as DatePreset); setOffset(0); }}
              className={INPUT_CLS}
              title="Date range"
            >
              <option value="this_week">This Week</option>
              <option value="last_2_weeks">Last 2 Weeks</option>
              <option value="this_month">This Month</option>
              <option value="last_month">Last Month</option>
              <option value="custom">Custom Range</option>
            </select>
            {datePreset === 'custom' && (
              <>
                <input type="date" value={customFrom} onChange={(e) => { setCustomFrom(e.target.value); setOffset(0); }} className={INPUT_CLS} title="From" />
                <input type="date" value={customTo}   onChange={(e) => { setCustomTo(e.target.value);   setOffset(0); }} className={INPUT_CLS} title="To" />
              </>
            )}
            <button type="button" className="btn-g btn-sm" onClick={loadList} disabled={loading}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
        </div>

        {/* TODO: settlement detail view (future) — full per-settlement
            ledger-debit breakdown (platform_fee/gst per branch, tds, payout)
            + covered order-revenue window. Out of scope for this prompt. */}

        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadList} /></div>
        ) : loading ? (
          <div className={EMPTY_CLS}>Loading…</div>
        ) : grouped.length === 0 ? (
          <div className={EMPTY_CLS}>
            No settlements match this filter. Auto-settlement runs every Monday &amp; Thursday at 06:00 IST.
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {grouped.map((g) => (
              <div key={g.rid} className="border border-rim rounded-md overflow-hidden">
                <div className="bg-ink py-2 px-3">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <strong className="text-sm">{g.name}</strong>
                    <span className="text-xs text-dim mono">{g.rid.slice(0, 8)}</span>
                    <span className="text-xs text-dim ml-auto">{g.items.length} settlement(s)</span>
                  </div>
                  {g.bank ? (
                    <div className="mt-1.5 flex items-center gap-x-4 gap-y-1 flex-wrap text-xs">
                      <span className="text-dim">
                        Holder: <span className="font-medium">{g.bank.account_holder_name || '—'}</span>
                      </span>
                      <span className="text-dim flex items-center gap-1">
                        A/C: <span className="font-medium mono">{g.bank.account_number || '—'}</span>
                        {g.bank.account_number && (
                          <button
                            type="button"
                            className="btn-g btn-sm py-0.5 px-1.5 text-xs"
                            onClick={() => g.bank?.account_number && copyValue(g.bank.account_number, 'account number')}
                            title="Copy account number"
                          >
                            Copy
                          </button>
                        )}
                      </span>
                      <span className="text-dim flex items-center gap-1">
                        IFSC: <span className="font-medium mono">{g.bank.ifsc || '—'}</span>
                        {g.bank.ifsc && (
                          <button
                            type="button"
                            className="btn-g btn-sm py-0.5 px-1.5 text-xs"
                            onClick={() => g.bank?.ifsc && copyValue(g.bank.ifsc, 'IFSC')}
                            title="Copy IFSC"
                          >
                            Copy
                          </button>
                        )}
                      </span>
                      {g.bank.bank_name && (
                        <span className="text-dim">Bank: <span className="font-medium">{g.bank.bank_name}</span></span>
                      )}
                    </div>
                  ) : (
                    <div className="mt-1.5 inline-block bg-amber-100 text-amber-800 text-xs py-1 px-2 rounded">
                      ⚠ Bank details not configured for this restaurant. Cannot mark settlements paid until bank info is added.
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-rim">
                        <th className={TH_CLS}>Date</th>
                        <th className={TH_CLS}>Status</th>
                        <th className={TH_CLS}>Gross Revenue</th>
                        <th className={TH_CLS}>Refunds</th>
                        <th className={TH_CLS}>Platform Fee</th>
                        <th className={TH_CLS}>TDS</th>
                        <th className={TH_CLS}>Meta Cost</th>
                        <th className={TH_CLS}>Net Payable</th>
                        <th className={TH_CLS}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map((s) => {
                        const st = normStatus(s);
                        const badge = STATUS_BADGE[st] || { cls: 'bg-neutral-200 text-neutral-700', label: st || '—' };
                        const metaCount = s.meta_message_count || 0;
                        const metaRs = (s.meta_cost_total_paise || 0) / 100;
                        const branchCount = s.platform_fee_branch_count || 0;
                        const feeRs = parseFloat(String(s.platform_fee_rs)) || ((s.platform_fee_paise || 0) / 100);
                        const gstRs = (s.platform_fee_gst_paise || 0) / 100;
                        const isPendingPayout = st === 'pending_manual_payout' && !!s.payout_id;
                        const hasBank = !!s.restaurant_bank_details;
                        return (
                          <tr key={s.id} className="border-b border-rim">
                            <td className={`${TD_CLS} text-dim text-xs whitespace-nowrap`}>{fmtTime(s.created_at)}</td>
                            <td className={TD_CLS}>
                              <span className={`inline-block py-0.5 px-2 rounded font-semibold text-xs ${badge.cls}`}>
                                {badge.label}
                              </span>
                            </td>
                            <td className={TD_CLS}>₹{fmtCompact(s.gross_revenue_rs)}</td>
                            <td className={TD_CLS}>
                              {s.refunds_rs && s.refunds_rs > 0
                                ? <span className="text-red-500">₹{fmtCompact(s.refunds_rs)}</span>
                                : '—'}
                            </td>
                            <td className={`${TD_CLS} text-acc`}>
                              {feeRs > 0 ? (
                                <span title={gstRs > 0 ? `Fee ₹${feeRs.toFixed(2)} + GST ₹${gstRs.toFixed(2)}` : undefined}>
                                  ₹{fmtCompact(feeRs)}
                                  {branchCount > 1 && (
                                    <span className="text-dim text-xs"> ({branchCount} branches × ₹3,000)</span>
                                  )}
                                </span>
                              ) : '—'}
                            </td>
                            <td className={TD_CLS}>
                              {s.tds_amount_rs && parseFloat(String(s.tds_amount_rs)) > 0
                                ? `₹${fmtCompact(s.tds_amount_rs)}`
                                : '—'}
                            </td>
                            <td className={TD_CLS}>
                              {metaCount > 0 ? (
                                <button
                                  type="button"
                                  className="btn-g btn-sm py-1 px-2 text-xs text-red-600"
                                  onClick={() => openBreakdown(s.id)}
                                  title={`View ${metaCount} messages`}
                                >
                                  ₹{fmtCompact(metaRs)} · {metaCount}
                                </button>
                              ) : <span className="text-dim">—</span>}
                            </td>
                            <td className={TD_CLS}><strong>₹{fmtCompact(s.net_payout_rs)}</strong></td>
                            <td className={TD_CLS}>
                              <div className="flex gap-1.5 justify-end">
                                {isPendingPayout && (
                                  <button
                                    type="button"
                                    className="btn-p btn-sm py-1 px-2 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                                    disabled={!hasBank}
                                    title={hasBank ? undefined : 'Restaurant bank details required to mark paid.'}
                                    onClick={() => hasBank && setMarkPaid({
                                      payoutId: String(s.payout_id),
                                      label: `${g.name} · ₹${fmtCompact(s.net_payout_rs)}`,
                                      utr: '',
                                      notes: '',
                                      submitting: false,
                                      error: null,
                                    })}
                                  >
                                    Mark Paid
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn-g btn-sm py-1 px-2 text-xs"
                                  onClick={() => doDownload(s.id)}
                                  title="Download Excel"
                                >
                                  Excel
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}

        {total > 0 && (
          <div className="cb flex gap-2.5 items-center justify-center">
            <button
              type="button"
              className="btn-g btn-sm"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - STL_LIMIT))}
            >
              ← Prev
            </button>
            <span className="text-sm text-dim">Page {page} / {pages}</span>
            <button
              type="button"
              className="btn-g btn-sm"
              disabled={offset + STL_LIMIT >= total || loading}
              onClick={() => setOffset(offset + STL_LIMIT)}
            >
              Next →
            </button>
            <span className="text-xs text-dim ml-2.5">
              {total} settlements
            </span>
          </div>
        )}
      </div>

      {markPaid && (
        <div
          onClick={() => !markPaid.submitting && setMarkPaid(null)}
          className="fixed inset-0 bg-black/55 flex items-center justify-center z-1000 p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-neutral-0 rounded-r w-[min(440px,100%)] py-5 px-6 relative"
          >
            <button
              type="button"
              onClick={() => !markPaid.submitting && setMarkPaid(null)}
              className="absolute top-2.5 right-3 bg-transparent border-0 text-[1.4rem] cursor-pointer text-dim"
              aria-label="Close"
            >
              ×
            </button>
            <h2 className="m-0 mb-1 text-lg">Mark Settlement Paid</h2>
            <div className="text-dim text-sm mb-4">{markPaid.label}</div>
            <label className="block text-xs text-dim font-bold uppercase tracking-[0.04em] mb-1">
              Bank UTR <span className="text-red-500">*</span>
            </label>
            <input
              value={markPaid.utr}
              onChange={(e) => setMarkPaid({ ...markPaid, utr: e.target.value, error: null })}
              placeholder="e.g. SBIN0XXXXXXXXXX"
              className={`${INPUT_CLS} w-full mb-3`}
              autoFocus
            />
            <label className="block text-xs text-dim font-bold uppercase tracking-[0.04em] mb-1">
              Notes <span className="text-dim normal-case font-normal">(optional)</span>
            </label>
            <textarea
              value={markPaid.notes}
              onChange={(e) => setMarkPaid({ ...markPaid, notes: e.target.value })}
              rows={3}
              className={`${INPUT_CLS} w-full mb-3 resize-y`}
            />
            {markPaid.error && (
              <div className="text-red-600 text-sm mb-3">{markPaid.error}</div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                className="btn-g btn-sm"
                onClick={() => setMarkPaid(null)}
                disabled={markPaid.submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-p btn-sm"
                onClick={submitMarkPaid}
                disabled={markPaid.submitting}
              >
                {markPaid.submitting ? 'Saving…' : 'Confirm Paid'}
              </button>
            </div>
          </div>
        </div>
      )}

      {breakdown && (
        <div
          onClick={closeBreakdown}
          className="fixed inset-0 bg-black/55 flex items-center justify-center z-1000 p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-neutral-0 rounded-r w-[min(960px,100%)] max-h-[86vh] overflow-auto py-5 px-6 relative"
          >
            <button
              type="button"
              onClick={closeBreakdown}
              className="absolute top-2.5 right-3 bg-transparent border-0 text-[1.4rem] cursor-pointer text-dim"
              aria-label="Close"
            >
              ×
            </button>
            <h2 className="m-0 mb-1">Meta Messaging Charges</h2>
            <div className="text-dim text-sm mb-3">
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
              <table className="w-full text-sm border-collapse">
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
                      <td className={`${TD_CLS} text-xs text-dim mono`}>
                        {String(m.restaurant_id || '').slice(0, 8) || '—'}
                      </td>
                      <td className={`${TD_CLS} text-xs text-dim mono`}>
                        {m.waba_id || '—'}
                      </td>
                      <td className={TD_CLS}>{m.customer_name || '—'}</td>
                      <td className={`${TD_CLS} text-dim mono`}>{m.phone || '—'}</td>
                      <td className={TD_CLS}>{m.message_type || '—'}</td>
                      <td className={TD_CLS}>{m.category || '—'}</td>
                      <td className={TD_CLS}>₹{Number(m.cost || 0).toFixed(2)}</td>
                      <td className={`${TD_CLS} text-dim text-xs`}>{fmtTime(m.sent_at)}</td>
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
