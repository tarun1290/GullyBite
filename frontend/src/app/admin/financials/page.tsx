'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getAdminRestaurants,
  getFinancialsOverview,
  getFinancialsSettlements,
  getFinancialsSettlement,
  payFinancialsSettlement,
  getFinancialsPayments,
  getFinancialsRefunds,
  getFinancialsTax,
  downloadTdsReportBlob,
  downloadGstr1Blob,
} from '../../../api/admin';

const PERIODS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '7d', label: 'This Week' },
  { value: '30d', label: 'This Month' },
  { value: '90d', label: 'Last 90 Days' },
  { value: 'this_fy', label: 'This FY' },
];

const SUBS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'overview',    label: 'Overview' },
  { id: 'settlements', label: 'Settlements' },
  { id: 'payments',    label: 'Payments' },
  { id: 'refunds',     label: 'Refunds' },
  { id: 'tax',         label: 'Tax & Compliance' },
];

interface RestaurantApiRow {
  id?: string;
  _id?: string;
  restaurant_id?: string;
  business_name?: string;
  name?: string;
  restaurant_name?: string;
}

interface RestaurantsEnvelope { restaurants?: RestaurantApiRow[] }

interface FinancialsOverview {
  gmv_rs?: number | string;
  platform_fee_rs?: number | string;
  platform_fee_gst_rs?: number | string;
  total_payouts_rs?: number | string;
  pending_payouts_rs?: number | string;
  pending_payouts_count?: number;
  total_refunds_rs?: number | string;
  total_tds_rs?: number | string;
  delivery_costs_rs?: number | string;
  // Flat per-order GullyBite delivery markup summed across the period.
  // Pure platform-revenue metric — admin-only; never surfaced to the
  // restaurant-facing payments page.
  platform_markup_collected_rs?: number | string;
}

interface FinSettlement {
  id?: string;
  restaurant_name?: string;
  restaurant_id?: string;
  period?: string;
  gross_rs?: number | string;
  platform_fee_rs?: number | string;
  tds_rs?: number | string;
  net_rs?: number | string;
  status?: string;
  utr?: string;
}

interface SettlementsResponse {
  settlements?: FinSettlement[];
  data?: FinSettlement[];
  total?: number;
}

interface FinPayment {
  id?: string;
  date?: string;
  created_at?: string;
  order_id?: string;
  amount_rs?: number | string;
  method?: string;
  razorpay_payment_id?: string;
  status?: string;
}

interface PaymentsResponse {
  payments?: FinPayment[];
  data?: FinPayment[];
  total?: number;
}

interface FinRefund {
  id?: string;
  date?: string;
  created_at?: string;
  restaurant_name?: string;
  order_id?: string;
  amount_rs?: number | string;
  reason?: string;
  razorpay_refund_id?: string;
  status?: string;
}

interface RefundsResponse {
  refunds?: FinRefund[];
  data?: FinRefund[];
  total?: number;
}

interface TdsRow { restaurant_name?: string; pan?: string; gross_rs?: number | string; tds_rs?: number | string; net_rs?: number | string }
interface GstMonthRow { month?: string; fees_rs?: number | string; cgst_rs?: number | string; sgst_rs?: number | string; total_gst_rs?: number | string }

interface TaxData {
  tds?: { restaurants?: TdsRow[]; total_gross_rs?: number | string; total_tds_rs?: number | string; restaurant_count?: number };
  gst?: { months?: GstMonthRow[]; total_fees_rs?: number | string; cgst_rs?: number | string; sgst_rs?: number | string; total_gst_rs?: number | string };
}

interface DetailState {
  id: string;
  data: unknown | null;
  err: string | null;
  loading: boolean;
}

function fmtINR(n: number | string | null | undefined): string {
  if (n == null || isNaN(Number(n))) return '₹0';
  return '₹' + parseFloat(String(n)).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return '—'; }
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface StatusColor { bg: string; color: string }

function pickStatusColor(status: string | undefined, type: 'settlement' | 'payment' | 'refund' = 'settlement'): StatusColor {
  const s = String(status || '').toLowerCase();
  if (type === 'settlement') {
    if (s === 'paid') return { bg: 'rgba(34,197,94,.16)', color: '#047857' };
    if (s === 'failed') return { bg: 'rgba(239,68,68,.16)', color: 'var(--gb-red-600)' };
    return { bg: 'rgba(245,158,11,.16)', color: 'var(--gb-amber-600)' };
  }
  if (type === 'payment') {
    if (s === 'captured' || s === 'paid') return { bg: 'rgba(34,197,94,.16)', color: '#047857' };
    if (s === 'failed') return { bg: 'rgba(239,68,68,.16)', color: 'var(--gb-red-600)' };
    return { bg: 'rgba(245,158,11,.16)', color: 'var(--gb-amber-600)' };
  }
  if (s === 'processed') return { bg: 'rgba(34,197,94,.16)', color: '#047857' };
  if (s === 'failed') return { bg: 'rgba(239,68,68,.16)', color: 'var(--gb-red-600)' };
  return { bg: 'rgba(245,158,11,.16)', color: 'var(--gb-amber-600)' };
}

interface StatusBadgeProps { status?: string; type?: 'settlement' | 'payment' | 'refund' }

function StatusBadge({ status, type }: StatusBadgeProps): ReactNode {
  const c = pickStatusColor(status, type);
  return (
    <span
      // bg + color come from pickStatusColor() palette by status/type at runtime
      style={{ background: c.bg, color: c.color }}
      className="inline-block py-[0.15rem] px-[0.55rem] rounded-[10px] font-semibold text-[0.72rem] capitalize"
    >{status || '-'}</span>
  );
}

const TABLE_CLS = 'w-full border-collapse text-[0.82rem]';
const TR_HEAD_CLS = 'bg-ink border-b border-rim';
const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.55rem] px-[0.7rem] align-top';
const EMPTY_CELL_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.3rem] px-[0.6rem] text-[0.78rem]';

type ToastFn = (text: string, type?: 'success' | 'error' | 'info' | 'warning') => void;

export default function AdminFinancialsPage() {
  const { showToast } = useToast();
  const [period, setPeriod] = useState<string>('30d');
  const [sub, setSub] = useState<string>('overview');
  const [restaurants, setRestaurants] = useState<RestaurantApiRow[]>([]);

  useEffect(() => {
    (getAdminRestaurants() as Promise<RestaurantApiRow[] | RestaurantsEnvelope | null>)
      .then((list) => {
        const items: RestaurantApiRow[] = Array.isArray(list) ? list : (list?.restaurants || []);
        setRestaurants(items);
      })
      .catch(() => setRestaurants([]));
  }, []);

  return (
    <div id="pg-financials">
      <OverviewStats period={period} />

      <div className="flex gap-[0.4rem] mb-4 flex-wrap items-center">
        {SUBS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={sub === t.id ? 'btn-p btn-sm' : 'btn-g btn-sm'}
            onClick={() => setSub(t.id)}
          >
            {t.label}
          </button>
        ))}
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className={`ml-auto ${INPUT_CLS}`}
        >
          {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>

      {sub === 'overview'    && <OverviewSection period={period} restaurants={restaurants} />}
      {sub === 'settlements' && <SettlementsSection showToast={showToast} />}
      {sub === 'payments'    && <PaymentsSection />}
      {sub === 'refunds'     && <RefundsSection />}
      {sub === 'tax'         && <TaxSection period={period} showToast={showToast} />}
    </div>
  );
}

interface PeriodProps { period: string }

function OverviewStats({ period }: PeriodProps): ReactNode {
  const [data, setData] = useState<FinancialsOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = (await getFinancialsOverview(period)) as FinancialsOverview | null;
      setData(d);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Overview failed');
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <div className="mb-4">
        <SectionError message={err} onRetry={load} />
      </div>
    );
  }

  return (
    // gridTemplateColumns uses an auto-fit minmax pattern not expressible as a static Tailwind class
    <div className="stats mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
      <StatCard label="Total GMV"        value={data ? fmtINR(data.gmv_rs) : '—'} />
      <StatCard label="Platform Revenue" value={data ? fmtINR(data.platform_fee_rs) : '—'} />
      <StatCard label="GST Liability"    value={data ? fmtINR(data.platform_fee_gst_rs) : '—'} />
      <StatCard label="Total Payouts"    value={data ? fmtINR(data.total_payouts_rs) : '—'} />
      <StatCard label="Pending Payouts"  value={data ? fmtINR(data.pending_payouts_rs) : '—'} delta={data?.pending_payouts_count ? `${data.pending_payouts_count} pending` : ''} />
      <StatCard label="Total Refunds"    value={data ? fmtINR(data.total_refunds_rs) : '—'} />
      <StatCard label="TDS Deducted"     value={data ? fmtINR(data.total_tds_rs) : '—'} />
      <StatCard label="3PL Costs"        value={data ? fmtINR(data.delivery_costs_rs) : '—'} />
      <StatCard label="Platform Markup Revenue" value={data ? fmtINR(data.platform_markup_collected_rs) : '—'} />
    </div>
  );
}

interface OverviewSectionProps { period: string; restaurants: RestaurantApiRow[] }

function OverviewSection({ period, restaurants }: OverviewSectionProps): ReactNode {
  const [data, setData] = useState<FinancialsOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [trackerRest, setTrackerRest] = useState<string>('');
  const [trackerStatus, setTrackerStatus] = useState<string>('');
  const [trackerPage, setTrackerPage] = useState<number>(1);
  const [trackerRows, setTrackerRows] = useState<FinSettlement[]>([]);
  const [trackerTotal, setTrackerTotal] = useState<number>(0);
  const [trackerLoading, setTrackerLoading] = useState<boolean>(true);
  const [trackerErr, setTrackerErr] = useState<string | null>(null);

  const loadCashflow = useCallback(async () => {
    try {
      const d = (await getFinancialsOverview(period)) as FinancialsOverview | null;
      setData(d);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Cash flow failed');
    }
  }, [period]);

  const loadTracker = useCallback(async () => {
    setTrackerLoading(true);
    const params: Record<string, string | number> = { period, page: trackerPage, limit: 20 };
    if (trackerRest) params.restaurant_id = trackerRest;
    if (trackerStatus) params.status = trackerStatus;
    try {
      const d = (await getFinancialsSettlements(params)) as SettlementsResponse | null;
      const rows = d?.settlements || d?.data || [];
      setTrackerRows(Array.isArray(rows) ? rows : []);
      setTrackerTotal(d?.total || rows.length || 0);
      setTrackerErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setTrackerRows([]);
      setTrackerTotal(0);
      setTrackerErr(er?.response?.data?.error || er?.message || 'Tracker failed');
    } finally {
      setTrackerLoading(false);
    }
  }, [period, trackerPage, trackerRest, trackerStatus]);

  useEffect(() => { loadCashflow(); }, [loadCashflow]);
  useEffect(() => { loadTracker(); }, [loadTracker]);

  return (
    <>
      <div className="card mb-4">
        <div className="ch"><h3>Cash Flow Summary</h3></div>
        <div className="cb">
          {err ? (
            <SectionError message={err} onRetry={loadCashflow} />
          ) : !data ? (
            <div className="text-dim">Loading…</div>
          ) : (
            <div className="grid grid-cols-2 gap-4 text-[0.85rem]">
              <div>
                <strong className="text-[#047857]">Money In</strong><br />
                GMV Collected: {fmtINR(data.gmv_rs)}
              </div>
              <div>
                <strong className="text-red-600">Money Out</strong><br />
                Restaurant Payouts: {fmtINR(data.total_payouts_rs)}<br />
                Refunds: {fmtINR(data.total_refunds_rs)}<br />
                3PL Costs: {fmtINR(data.delivery_costs_rs)}<br />
                TDS Remitted: {fmtINR(data.total_tds_rs)}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="ch flex-wrap gap-2">
          <h3 className="m-0">Settlement Tracker</h3>
          <div className="ml-auto flex gap-[0.4rem] flex-wrap">
            <select
              value={trackerRest}
              onChange={(e) => { setTrackerRest(e.target.value); setTrackerPage(1); }}
              className={INPUT_CLS}
            >
              <option value="">All Restaurants</option>
              {restaurants.map((r) => {
                const id = r.id || r.restaurant_id || '';
                return <option key={id} value={id}>{r.name || r.restaurant_name || r.business_name || id}</option>;
              })}
            </select>
            <select
              value={trackerStatus}
              onChange={(e) => { setTrackerStatus(e.target.value); setTrackerPage(1); }}
              className={INPUT_CLS}
            >
              <option value="">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="paid">Paid</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>
        {trackerErr ? (
          <div className="cb"><SectionError message={trackerErr} onRetry={loadTracker} /></div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={TABLE_CLS}>
                <thead>
                  <tr className={TR_HEAD_CLS}>
                    <th className={TH_CLS}>Restaurant</th>
                    <th className={TH_CLS}>Period</th>
                    <th className={TH_CLS}>Gross</th>
                    <th className={TH_CLS}>Platform Fee</th>
                    <th className={TH_CLS}>TDS</th>
                    <th className={TH_CLS}>Net</th>
                    <th className={TH_CLS}>Status</th>
                    <th className={TH_CLS}>UTR</th>
                  </tr>
                </thead>
                <tbody>
                  {trackerLoading ? (
                    <tr><td colSpan={8} className={EMPTY_CELL_CLS}>Loading…</td></tr>
                  ) : trackerRows.length === 0 ? (
                    <tr><td colSpan={8} className={EMPTY_CELL_CLS}>No settlements found</td></tr>
                  ) : trackerRows.map((s, i) => (
                    <tr key={s.id || i} className="border-b border-rim">
                      <td className={TD_CLS}>{s.restaurant_name || s.restaurant_id || '-'}</td>
                      <td className={TD_CLS}>{s.period || '-'}</td>
                      <td className={TD_CLS}>{fmtINR(s.gross_rs)}</td>
                      <td className={TD_CLS}>{fmtINR(s.platform_fee_rs)}</td>
                      <td className={TD_CLS}>{fmtINR(s.tds_rs)}</td>
                      <td className={TD_CLS}>{fmtINR(s.net_rs)}</td>
                      <td className={TD_CLS}><StatusBadge status={s.status} type="settlement" /></td>
                      <td className={`${TD_CLS} text-[0.75rem] mono`}>{s.utr || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={trackerPage} rows={trackerRows.length} total={trackerTotal} onPage={setTrackerPage} limit={20} disabled={trackerLoading} />
          </>
        )}
      </div>
    </>
  );
}

interface SettlementsSectionProps { showToast: ToastFn }

function SettlementsSection({ showToast }: SettlementsSectionProps): ReactNode {
  const [page, setPage] = useState<number>(1);
  const [rows, setRows] = useState<FinSettlement[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [payingId, setPayingId] = useState<string>('');
  const [confirmId, setConfirmId] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = (await getFinancialsSettlements({ page, limit: 20 })) as SettlementsResponse | null;
      const list = d?.settlements || d?.data || [];
      setRows(Array.isArray(list) ? list : []);
      setTotal(d?.total || list.length || 0);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setErr(er?.response?.data?.error || er?.message || 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  const doView = async (id: string) => {
    setDetail({ id, data: null, err: null, loading: true });
    try {
      const d = await getFinancialsSettlement(id);
      setDetail({ id, data: d, err: null, loading: false });
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setDetail({ id, data: null, err: er?.response?.data?.error || er?.message || 'Load failed', loading: false });
    }
  };

  const doPay = async (id: string) => {
    if (confirmId !== id) { setConfirmId(id); return; }
    setConfirmId('');
    setPayingId(id);
    try {
      await payFinancialsSettlement(id);
      showToast('Payout initiated', 'success');
      load();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Payout failed', 'error');
    } finally {
      setPayingId('');
    }
  };

  return (
    <div className="card">
      <div className="ch"><h3>Settlements</h3></div>
      {err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className={TABLE_CLS}>
              <thead>
                <tr className={TR_HEAD_CLS}>
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Period</th>
                  <th className={TH_CLS}>Gross</th>
                  <th className={TH_CLS}>Fees</th>
                  <th className={TH_CLS}>TDS</th>
                  <th className={TH_CLS}>Net</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className={EMPTY_CELL_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8} className={EMPTY_CELL_CLS}>No settlements</td></tr>
                ) : rows.map((s, i) => (
                  <tr key={s.id || i} className="border-b border-rim">
                    <td className={TD_CLS}>{s.restaurant_name || s.restaurant_id || '-'}</td>
                    <td className={TD_CLS}>{s.period || '-'}</td>
                    <td className={TD_CLS}>{fmtINR(s.gross_rs)}</td>
                    <td className={TD_CLS}>{fmtINR(s.platform_fee_rs)}</td>
                    <td className={TD_CLS}>{fmtINR(s.tds_rs)}</td>
                    <td className={TD_CLS}>{fmtINR(s.net_rs)}</td>
                    <td className={TD_CLS}><StatusBadge status={s.status} type="settlement" /></td>
                    <td className={TD_CLS}>
                      <button type="button" className="btn-g btn-sm" onClick={() => s.id && doView(s.id)}>View</button>
                      {s.status !== 'paid' && (
                        <button
                          type="button"
                          className="btn-p btn-sm ml-[0.35rem]"
                          onClick={() => s.id && doPay(s.id)}
                          disabled={payingId === s.id}
                        >
                          {payingId === s.id ? 'Paying…' : confirmId === s.id ? 'Confirm?' : 'Pay'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} rows={rows.length} total={total} onPage={setPage} limit={20} disabled={loading} />
        </>
      )}

      {detail && (
        <div
          onClick={() => setDetail(null)}
          className="fixed inset-0 bg-[rgba(0,0,0,0.55)] flex items-center justify-center z-1000 p-[1.4rem]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            // width uses min(720px, 100%) which is not expressible as a static Tailwind class
            style={{ width: 'min(720px, 100%)' }}
            className="bg-neutral-0 rounded-lg max-h-[86vh] overflow-auto py-[1.2rem] px-[1.4rem] relative"
          >
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="absolute top-[0.6rem] right-[0.8rem] bg-transparent border-0 text-[1.4rem] cursor-pointer text-dim"
              aria-label="Close"
            >
              ×
            </button>
            <h2 className="m-0 mb-2">Settlement Details</h2>
            <div className="text-[0.78rem] text-dim mb-[0.8rem] mono">
              {detail.id}
            </div>
            {detail.loading ? (
              <div className="text-dim">Loading…</div>
            ) : detail.err ? (
              <SectionError message={detail.err} onRetry={() => doView(detail.id)} />
            ) : (
              <pre className="m-0 text-[0.75rem] leading-normal bg-ink3 p-4 rounded-md overflow-auto max-h-[60vh]">
                {JSON.stringify(detail.data, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PaymentsSection(): ReactNode {
  const [page, setPage] = useState<number>(1);
  const [rows, setRows] = useState<FinPayment[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = (await getFinancialsPayments({ page, limit: 20 })) as PaymentsResponse | null;
      const list = d?.payments || d?.data || [];
      setRows(Array.isArray(list) ? list : []);
      setTotal(d?.total || list.length || 0);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Load failed');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card">
      <div className="ch"><h3>Payments</h3></div>
      {err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className={TABLE_CLS}>
              <thead>
                <tr className={TR_HEAD_CLS}>
                  <th className={TH_CLS}>Date</th>
                  <th className={TH_CLS}>Order #</th>
                  <th className={TH_CLS}>Amount</th>
                  <th className={TH_CLS}>Method</th>
                  <th className={TH_CLS}>Razorpay ID</th>
                  <th className={TH_CLS}>Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className={EMPTY_CELL_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} className={EMPTY_CELL_CLS}>No payments</td></tr>
                ) : rows.map((p, i) => (
                  <tr key={p.id || i} className="border-b border-rim">
                    <td className={TD_CLS}>{fmtDate(p.date || p.created_at)}</td>
                    <td className={`${TD_CLS} mono`}>{p.order_id || '-'}</td>
                    <td className={TD_CLS}>{fmtINR(p.amount_rs)}</td>
                    <td className={TD_CLS}>{p.method || '-'}</td>
                    <td className={`${TD_CLS} max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap mono`}>
                      {p.razorpay_payment_id || '-'}
                    </td>
                    <td className={TD_CLS}><StatusBadge status={p.status} type="payment" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} rows={rows.length} total={total} onPage={setPage} limit={20} disabled={loading} />
        </>
      )}
    </div>
  );
}

function RefundsSection(): ReactNode {
  const [page, setPage] = useState<number>(1);
  const [rows, setRows] = useState<FinRefund[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = (await getFinancialsRefunds({ page, limit: 20 })) as RefundsResponse | null;
      const list = d?.refunds || d?.data || [];
      setRows(Array.isArray(list) ? list : []);
      setTotal(d?.total || list.length || 0);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Load failed');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card">
      <div className="ch"><h3>Refunds</h3></div>
      {err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className={TABLE_CLS}>
              <thead>
                <tr className={TR_HEAD_CLS}>
                  <th className={TH_CLS}>Date</th>
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Order #</th>
                  <th className={TH_CLS}>Amount</th>
                  <th className={TH_CLS}>Reason</th>
                  <th className={TH_CLS}>Razorpay Refund ID</th>
                  <th className={TH_CLS}>Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className={EMPTY_CELL_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} className={EMPTY_CELL_CLS}>No refunds</td></tr>
                ) : rows.map((r, i) => (
                  <tr key={r.id || i} className="border-b border-rim">
                    <td className={TD_CLS}>{fmtDate(r.date || r.created_at)}</td>
                    <td className={TD_CLS}>{r.restaurant_name || '-'}</td>
                    <td className={`${TD_CLS} mono`}>{r.order_id || '-'}</td>
                    <td className={TD_CLS}>{fmtINR(r.amount_rs)}</td>
                    <td className={TD_CLS}>{r.reason || '-'}</td>
                    <td className={`${TD_CLS} max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap mono`}>
                      {r.razorpay_refund_id || '-'}
                    </td>
                    <td className={TD_CLS}><StatusBadge status={r.status} type="refund" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} rows={rows.length} total={total} onPage={setPage} limit={20} disabled={loading} />
        </>
      )}
    </div>
  );
}

interface TaxSectionProps { period: string; showToast: ToastFn }

function TaxSection({ period, showToast }: TaxSectionProps): ReactNode {
  const [data, setData] = useState<TaxData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [downloading, setDownloading] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = (await getFinancialsTax(period)) as TaxData | null;
      setData(d);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const doDownload = async (kind: 'tds' | 'gst') => {
    setDownloading(kind);
    try {
      if (kind === 'tds') {
        const { blob } = await downloadTdsReportBlob(period);
        saveBlob(blob, `tds_report_${period}.csv`);
        showToast('TDS report downloaded', 'success');
      } else {
        const { blob } = await downloadGstr1Blob(period);
        saveBlob(blob, `gstr1_${period}.csv`);
        showToast('GSTR-1 data downloaded', 'success');
      }
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Download failed', 'error');
    } finally {
      setDownloading('');
    }
  };

  const tds = data?.tds || {};
  const gst = data?.gst || {};
  const tdsRows = tds.restaurants || [];
  const gstMonths = gst.months || [];

  if (err) {
    return <SectionError message={err} onRetry={load} />;
  }

  return (
    <>
      <div className="card mb-4">
        <div className="ch justify-between">
          <h3 className="m-0">TDS Filing</h3>
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => doDownload('tds')}
            disabled={downloading === 'tds'}
          >
            {downloading === 'tds' ? 'Downloading…' : 'Download TDS Report'}
          </button>
        </div>
        <div className="cb text-[0.85rem]">
          <strong>Quarterly TDS Summary:</strong>{' '}
          Total Gross Payouts: {fmtINR(tds.total_gross_rs)} |{' '}
          TDS Deducted (@1%): {fmtINR(tds.total_tds_rs)} |{' '}
          Restaurants: {tds.restaurant_count || 0}
        </div>
        <div className="overflow-x-auto">
          <table className={TABLE_CLS}>
            <thead>
              <tr className={TR_HEAD_CLS}>
                <th className={TH_CLS}>Restaurant</th>
                <th className={TH_CLS}>PAN</th>
                <th className={TH_CLS}>Gross Payouts</th>
                <th className={TH_CLS}>TDS @1%</th>
                <th className={TH_CLS}>Net Paid</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className={EMPTY_CELL_CLS}>Loading…</td></tr>
              ) : tdsRows.length === 0 ? (
                <tr><td colSpan={5} className={EMPTY_CELL_CLS}>No TDS data</td></tr>
              ) : tdsRows.map((r, i) => (
                <tr key={i} className="border-b border-rim">
                  <td className={TD_CLS}>{r.restaurant_name || '-'}</td>
                  <td className={`${TD_CLS} mono`}>{r.pan || '-'}</td>
                  <td className={TD_CLS}>{fmtINR(r.gross_rs)}</td>
                  <td className={TD_CLS}>{fmtINR(r.tds_rs)}</td>
                  <td className={TD_CLS}>{fmtINR(r.net_rs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="ch justify-between">
          <h3 className="m-0">GST Filing</h3>
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => doDownload('gst')}
            disabled={downloading === 'gst'}
          >
            {downloading === 'gst' ? 'Downloading…' : 'Download GSTR-1 Data'}
          </button>
        </div>
        <div className="cb text-[0.85rem]">
          <strong>Monthly Platform Fee GST:</strong>{' '}
          Total Platform Fees: {fmtINR(gst.total_fees_rs)} |{' '}
          CGST (9%): {fmtINR(gst.cgst_rs)} |{' '}
          SGST (9%): {fmtINR(gst.sgst_rs)} |{' '}
          Total GST: {fmtINR(gst.total_gst_rs)}
        </div>
        <div className="overflow-x-auto">
          <table className={TABLE_CLS}>
            <thead>
              <tr className={TR_HEAD_CLS}>
                <th className={TH_CLS}>Month</th>
                <th className={TH_CLS}>Platform Fees</th>
                <th className={TH_CLS}>CGST (9%)</th>
                <th className={TH_CLS}>SGST (9%)</th>
                <th className={TH_CLS}>Total GST</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className={EMPTY_CELL_CLS}>Loading…</td></tr>
              ) : gstMonths.length === 0 ? (
                <tr><td colSpan={5} className={EMPTY_CELL_CLS}>No GST data</td></tr>
              ) : gstMonths.map((m, i) => (
                <tr key={i} className="border-b border-rim">
                  <td className={TD_CLS}>{m.month || '-'}</td>
                  <td className={TD_CLS}>{fmtINR(m.fees_rs)}</td>
                  <td className={TD_CLS}>{fmtINR(m.cgst_rs)}</td>
                  <td className={TD_CLS}>{fmtINR(m.sgst_rs)}</td>
                  <td className={TD_CLS}>{fmtINR(m.total_gst_rs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

interface PagerProps {
  page: number;
  rows: number;
  total: number;
  onPage: (next: number) => void;
  limit: number;
  disabled: boolean;
}

function Pager({ page, rows, total, onPage, limit, disabled }: PagerProps): ReactNode {
  const pages = useMemo(() => Math.max(1, Math.ceil((total || 0) / limit)), [total, limit]);
  return (
    <div className="cb flex gap-[0.6rem] items-center justify-center">
      <button
        type="button"
        className="btn-g btn-sm"
        disabled={disabled || page <= 1}
        onClick={() => onPage(page - 1)}
      >
        ← Prev
      </button>
      <span className="text-[0.8rem] text-dim">Page {page} / {pages}</span>
      <button
        type="button"
        className="btn-g btn-sm"
        disabled={disabled || rows < limit}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
      <span className="text-[0.75rem] text-dim ml-[0.6rem]">{total} total</span>
    </div>
  );
}
