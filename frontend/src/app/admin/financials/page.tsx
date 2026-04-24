'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/dashboard/analytics/SectionError';
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
    <span style={{
      display: 'inline-block', padding: '.15rem .55rem', borderRadius: 10,
      background: c.bg, color: c.color, fontWeight: 600,
      fontSize: '.72rem', textTransform: 'capitalize',
    }}>{status || '-'}</span>
  );
}

const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' };
const trHead: CSSProperties = { background: 'var(--ink)', borderBottom: '1px solid var(--rim)' };
const th: CSSProperties = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.55rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input: CSSProperties = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.3rem .6rem', fontSize: '.78rem' };

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

      <div style={{ display: 'flex', gap: '.4rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
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
          style={{ marginLeft: 'auto', ...input }}
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
      <div style={{ marginBottom: '1rem' }}>
        <SectionError message={err} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: '1rem' }}>
      <StatCard label="Total GMV"        value={data ? fmtINR(data.gmv_rs) : '—'} />
      <StatCard label="Platform Revenue" value={data ? fmtINR(data.platform_fee_rs) : '—'} />
      <StatCard label="GST Liability"    value={data ? fmtINR(data.platform_fee_gst_rs) : '—'} />
      <StatCard label="Total Payouts"    value={data ? fmtINR(data.total_payouts_rs) : '—'} />
      <StatCard label="Pending Payouts"  value={data ? fmtINR(data.pending_payouts_rs) : '—'} delta={data?.pending_payouts_count ? `${data.pending_payouts_count} pending` : ''} />
      <StatCard label="Total Refunds"    value={data ? fmtINR(data.total_refunds_rs) : '—'} />
      <StatCard label="TDS Deducted"     value={data ? fmtINR(data.total_tds_rs) : '—'} />
      <StatCard label="3PL Costs"        value={data ? fmtINR(data.delivery_costs_rs) : '—'} />
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
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch"><h3>Cash Flow Summary</h3></div>
        <div className="cb">
          {err ? (
            <SectionError message={err} onRetry={loadCashflow} />
          ) : !data ? (
            <div style={{ color: 'var(--dim)' }}>Loading…</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', fontSize: '.85rem' }}>
              <div>
                <strong style={{ color: '#047857' }}>Money In</strong><br />
                GMV Collected: {fmtINR(data.gmv_rs)}
              </div>
              <div>
                <strong style={{ color: 'var(--gb-red-600)' }}>Money Out</strong><br />
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
        <div className="ch" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
          <h3 style={{ margin: 0 }}>Settlement Tracker</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
            <select
              value={trackerRest}
              onChange={(e) => { setTrackerRest(e.target.value); setTrackerPage(1); }}
              style={input}
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
              style={input}
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
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr style={trHead}>
                    <th style={th}>Restaurant</th>
                    <th style={th}>Period</th>
                    <th style={th}>Gross</th>
                    <th style={th}>Platform Fee</th>
                    <th style={th}>TDS</th>
                    <th style={th}>Net</th>
                    <th style={th}>Status</th>
                    <th style={th}>UTR</th>
                  </tr>
                </thead>
                <tbody>
                  {trackerLoading ? (
                    <tr><td colSpan={8} style={emptyCell}>Loading…</td></tr>
                  ) : trackerRows.length === 0 ? (
                    <tr><td colSpan={8} style={emptyCell}>No settlements found</td></tr>
                  ) : trackerRows.map((s, i) => (
                    <tr key={s.id || i} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td style={td}>{s.restaurant_name || s.restaurant_id || '-'}</td>
                      <td style={td}>{s.period || '-'}</td>
                      <td style={td}>{fmtINR(s.gross_rs)}</td>
                      <td style={td}>{fmtINR(s.platform_fee_rs)}</td>
                      <td style={td}>{fmtINR(s.tds_rs)}</td>
                      <td style={td}>{fmtINR(s.net_rs)}</td>
                      <td style={td}><StatusBadge status={s.status} type="settlement" /></td>
                      <td style={{ ...td, fontSize: '.75rem' }} className="mono">{s.utr || '-'}</td>
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
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr style={trHead}>
                  <th style={th}>Restaurant</th>
                  <th style={th}>Period</th>
                  <th style={th}>Gross</th>
                  <th style={th}>Fees</th>
                  <th style={th}>TDS</th>
                  <th style={th}>Net</th>
                  <th style={th}>Status</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8} style={emptyCell}>No settlements</td></tr>
                ) : rows.map((s, i) => (
                  <tr key={s.id || i} style={{ borderBottom: '1px solid var(--rim)' }}>
                    <td style={td}>{s.restaurant_name || s.restaurant_id || '-'}</td>
                    <td style={td}>{s.period || '-'}</td>
                    <td style={td}>{fmtINR(s.gross_rs)}</td>
                    <td style={td}>{fmtINR(s.platform_fee_rs)}</td>
                    <td style={td}>{fmtINR(s.tds_rs)}</td>
                    <td style={td}>{fmtINR(s.net_rs)}</td>
                    <td style={td}><StatusBadge status={s.status} type="settlement" /></td>
                    <td style={td}>
                      <button type="button" className="btn-g btn-sm" onClick={() => s.id && doView(s.id)}>View</button>
                      {s.status !== 'paid' && (
                        <button
                          type="button"
                          className="btn-p btn-sm"
                          onClick={() => s.id && doPay(s.id)}
                          disabled={payingId === s.id}
                          style={{ marginLeft: '.35rem' }}
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
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1.4rem',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--gb-neutral-0)', borderRadius: 10, width: 'min(720px, 100%)',
              maxHeight: '86vh', overflow: 'auto', padding: '1.2rem 1.4rem', position: 'relative',
            }}
          >
            <button
              type="button"
              onClick={() => setDetail(null)}
              style={{
                position: 'absolute', top: '.6rem', right: '.8rem', background: 'transparent',
                border: 0, fontSize: '1.4rem', cursor: 'pointer', color: 'var(--dim)',
              }}
              aria-label="Close"
            >
              ×
            </button>
            <h2 style={{ margin: '0 0 .5rem 0' }}>Settlement Details</h2>
            <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginBottom: '.8rem' }} className="mono">
              {detail.id}
            </div>
            {detail.loading ? (
              <div style={{ color: 'var(--dim)' }}>Loading…</div>
            ) : detail.err ? (
              <SectionError message={detail.err} onRetry={() => doView(detail.id)} />
            ) : (
              <pre style={{
                margin: 0, fontSize: '.75rem', lineHeight: 1.5,
                background: 'var(--ink3)', padding: '1rem', borderRadius: 6,
                overflow: 'auto', maxHeight: '60vh',
              }}>
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
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr style={trHead}>
                  <th style={th}>Date</th>
                  <th style={th}>Order #</th>
                  <th style={th}>Amount</th>
                  <th style={th}>Method</th>
                  <th style={th}>Razorpay ID</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} style={emptyCell}>No payments</td></tr>
                ) : rows.map((p, i) => (
                  <tr key={p.id || i} style={{ borderBottom: '1px solid var(--rim)' }}>
                    <td style={td}>{fmtDate(p.date || p.created_at)}</td>
                    <td style={td} className="mono">{p.order_id || '-'}</td>
                    <td style={td}>{fmtINR(p.amount_rs)}</td>
                    <td style={td}>{p.method || '-'}</td>
                    <td style={{ ...td, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="mono">
                      {p.razorpay_payment_id || '-'}
                    </td>
                    <td style={td}><StatusBadge status={p.status} type="payment" /></td>
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
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr style={trHead}>
                  <th style={th}>Date</th>
                  <th style={th}>Restaurant</th>
                  <th style={th}>Order #</th>
                  <th style={th}>Amount</th>
                  <th style={th}>Reason</th>
                  <th style={th}>Razorpay Refund ID</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} style={emptyCell}>No refunds</td></tr>
                ) : rows.map((r, i) => (
                  <tr key={r.id || i} style={{ borderBottom: '1px solid var(--rim)' }}>
                    <td style={td}>{fmtDate(r.date || r.created_at)}</td>
                    <td style={td}>{r.restaurant_name || '-'}</td>
                    <td style={td} className="mono">{r.order_id || '-'}</td>
                    <td style={td}>{fmtINR(r.amount_rs)}</td>
                    <td style={td}>{r.reason || '-'}</td>
                    <td style={{ ...td, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="mono">
                      {r.razorpay_refund_id || '-'}
                    </td>
                    <td style={td}><StatusBadge status={r.status} type="refund" /></td>
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
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>TDS Filing</h3>
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => doDownload('tds')}
            disabled={downloading === 'tds'}
          >
            {downloading === 'tds' ? 'Downloading…' : 'Download TDS Report'}
          </button>
        </div>
        <div className="cb" style={{ fontSize: '.85rem' }}>
          <strong>Quarterly TDS Summary:</strong>{' '}
          Total Gross Payouts: {fmtINR(tds.total_gross_rs)} |{' '}
          TDS Deducted (@1%): {fmtINR(tds.total_tds_rs)} |{' '}
          Restaurants: {tds.restaurant_count || 0}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr style={trHead}>
                <th style={th}>Restaurant</th>
                <th style={th}>PAN</th>
                <th style={th}>Gross Payouts</th>
                <th style={th}>TDS @1%</th>
                <th style={th}>Net Paid</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} style={emptyCell}>Loading…</td></tr>
              ) : tdsRows.length === 0 ? (
                <tr><td colSpan={5} style={emptyCell}>No TDS data</td></tr>
              ) : tdsRows.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--rim)' }}>
                  <td style={td}>{r.restaurant_name || '-'}</td>
                  <td style={td} className="mono">{r.pan || '-'}</td>
                  <td style={td}>{fmtINR(r.gross_rs)}</td>
                  <td style={td}>{fmtINR(r.tds_rs)}</td>
                  <td style={td}>{fmtINR(r.net_rs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>GST Filing</h3>
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => doDownload('gst')}
            disabled={downloading === 'gst'}
          >
            {downloading === 'gst' ? 'Downloading…' : 'Download GSTR-1 Data'}
          </button>
        </div>
        <div className="cb" style={{ fontSize: '.85rem' }}>
          <strong>Monthly Platform Fee GST:</strong>{' '}
          Total Platform Fees: {fmtINR(gst.total_fees_rs)} |{' '}
          CGST (9%): {fmtINR(gst.cgst_rs)} |{' '}
          SGST (9%): {fmtINR(gst.sgst_rs)} |{' '}
          Total GST: {fmtINR(gst.total_gst_rs)}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr style={trHead}>
                <th style={th}>Month</th>
                <th style={th}>Platform Fees</th>
                <th style={th}>CGST (9%)</th>
                <th style={th}>SGST (9%)</th>
                <th style={th}>Total GST</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} style={emptyCell}>Loading…</td></tr>
              ) : gstMonths.length === 0 ? (
                <tr><td colSpan={5} style={emptyCell}>No GST data</td></tr>
              ) : gstMonths.map((m, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--rim)' }}>
                  <td style={td}>{m.month || '-'}</td>
                  <td style={td}>{fmtINR(m.fees_rs)}</td>
                  <td style={td}>{fmtINR(m.cgst_rs)}</td>
                  <td style={td}>{fmtINR(m.sgst_rs)}</td>
                  <td style={td}>{fmtINR(m.total_gst_rs)}</td>
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
    <div className="cb" style={{ display: 'flex', gap: '.6rem', alignItems: 'center', justifyContent: 'center' }}>
      <button
        type="button"
        className="btn-g btn-sm"
        disabled={disabled || page <= 1}
        onClick={() => onPage(page - 1)}
      >
        ← Prev
      </button>
      <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>Page {page} / {pages}</span>
      <button
        type="button"
        className="btn-g btn-sm"
        disabled={disabled || rows < limit}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
      <span style={{ fontSize: '.75rem', color: 'var(--dim)', marginLeft: '.6rem' }}>{total} total</span>
    </div>
  );
}
