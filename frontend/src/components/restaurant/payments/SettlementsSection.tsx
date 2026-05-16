'use client';

import { useCallback, useEffect, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import SettlementDetailModal from './SettlementDetailModal';
import { getSettlements, getPayments, getBranches } from '../../../api/restaurant';
import type { Branch } from '../../../types';

const SETTLE_LIMIT = 10;
const PAY_LIMIT = 15;

const PAY_STATUS_CLS: Record<string, string> = { CAPTURED: 'bg', SUCCESS: 'bg', PENDING: 'ba', FAILED: 'br', REFUNDED: 'bv' };

// IST offset shift idiom used across the codebase: shift epoch by +5:30 so
// the UTC getters on the resulting Date read as IST wall-clock values.
const IST_MS = 5.5 * 60 * 60 * 1000;

type SettlePreset = 'this_week' | 'last_2_weeks' | 'this_month' | 'custom';

const SETTLE_PRESETS: ReadonlyArray<readonly [SettlePreset, string]> = [
  ['this_week', 'This Week'],
  ['last_2_weeks', 'Last 2 Weeks'],
  ['this_month', 'This Month'],
];

// Friendly, restaurant-facing status mapping. Normalizes the Phase 5
// `status` enum and any legacy `payout_status` into one of three buckets.
function settleStatusMeta(raw: string | undefined): { label: string; cls: string } {
  const s = (raw || '').toLowerCase();
  if (s === 'completed') return { label: 'Paid', cls: 'bg' };
  if (s === 'failed') return { label: 'Issue — contact support', cls: 'br' };
  // pending_manual_payout | processing | pending (legacy) → pending payout
  return { label: 'Pending payout', cls: 'ba' };
}

// Returns the IST month-to-date / week boundaries as ISO strings the backend
// can filter `created_at` against.
function presetRange(preset: SettlePreset): { from: string; to: string } {
  const nowMs = Date.now();
  const ist = new Date(nowMs + IST_MS);
  const toIso = new Date(nowMs).toISOString();
  let fromIst: Date;
  if (preset === 'last_2_weeks') {
    fromIst = new Date(ist.getTime() - 14 * 24 * 60 * 60 * 1000);
    fromIst.setUTCHours(0, 0, 0, 0);
  } else if (preset === 'this_month') {
    fromIst = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1, 0, 0, 0, 0));
  } else {
    // this_week → Monday 00:00 IST (getUTCDay on the shifted date is the IST weekday)
    const dow = ist.getUTCDay(); // 0=Sun..6=Sat
    const daysSinceMon = (dow + 6) % 7;
    fromIst = new Date(ist.getTime() - daysSinceMon * 24 * 60 * 60 * 1000);
    fromIst.setUTCHours(0, 0, 0, 0);
  }
  // Unshift the IST wall-clock boundary back to a real UTC instant.
  return { from: new Date(fromIst.getTime() - IST_MS).toISOString(), to: toIso };
}

function settleDateDisplay(d: string | undefined): string {
  if (!d) return '—';
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface Settlement {
  id: string;
  created_at?: string;
  status?: string;
  payout_status?: string;
  net_payout_rs?: number | string;
  platform_fee_rs?: number | string;
  platform_fee_branch_count?: number;
}

interface SettlementsResponse {
  settlements?: Settlement[];
  has_more?: boolean;
  total_pages?: number;
}

interface Payment {
  id?: string;
  razorpay_id?: string;
  date?: string;
  order_number?: string;
  display_order_id?: string;
  amount?: number | string;
  method?: string;
  status?: string;
}

interface PaymentsResponse {
  payments?: Payment[];
  has_more?: boolean;
  total_pages?: number;
}

function formatINR(n: number | string | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

interface SettlementsTableProps {
  settlementsQ: ReturnType<typeof useAnalyticsFetch<SettlementsResponse | null>>;
  onView: (id: string) => void;
}

const SETTLE_HEAD = (
  <thead><tr><th>Settlement Date</th><th>Status</th><th>Net Payable</th><th>Platform Fee</th><th /></tr></thead>
);

function platformFeeDisplay(s: Settlement): string {
  const fee = formatINR(s.platform_fee_rs);
  const count = Number(s.platform_fee_branch_count) || 0;
  return count > 1 ? `${fee} (${count} branches)` : fee;
}

function SettlementsTable({ settlementsQ, onView }: SettlementsTableProps) {
  const rows = settlementsQ.data?.settlements || [];
  if (settlementsQ.error) {
    return <div className="p-4"><SectionError message={settlementsQ.error} onRetry={settlementsQ.refetch} /></div>;
  }
  if (settlementsQ.loading && !settlementsQ.data) {
    return (
      <table>
        {SETTLE_HEAD}
        <tbody><tr><td colSpan={5} className="text-center p-5 text-dim">Loading…</td></tr></tbody>
      </table>
    );
  }
  if (!rows.length) {
    return (
      <table>
        {SETTLE_HEAD}
        <tbody><tr><td colSpan={5}><div className="empty"><div className="ei">💰</div><h3>No settlements yet</h3><p>Settlements appear after your first payout cycle</p></div></td></tr></tbody>
      </table>
    );
  }
  return (
    <table>
      {SETTLE_HEAD}
      <tbody>
        {rows.map((s) => {
          const { label, cls } = settleStatusMeta(s.status || s.payout_status);
          const net = Math.round(Number(s.net_payout_rs) || 0);
          return (
            <tr key={s.id}>
              <td className="text-sm">{settleDateDisplay(s.created_at)}</td>
              <td><span className={`badge ${cls}`}>{label}</span></td>
              <td>{net > 0 ? <strong>{formatINR(net)}</strong> : <span className="text-dim">No payout</span>}</td>
              <td>{platformFeeDisplay(s)}</td>
              <td><button type="button" className="btn-g btn-sm" onClick={() => onView(s.id)}>View</button></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface PaymentsLogTableProps {
  paymentsQ: ReturnType<typeof useAnalyticsFetch<PaymentsResponse | null>>;
}

function PaymentsLogTable({ paymentsQ }: PaymentsLogTableProps) {
  const rows = paymentsQ.data?.payments || [];
  if (paymentsQ.error) {
    return <div className="p-4"><SectionError message={paymentsQ.error} onRetry={paymentsQ.refetch} /></div>;
  }
  if (paymentsQ.loading && !paymentsQ.data) {
    return (
      <table>
        <thead><tr><th>Date</th><th>Order #</th><th>Amount</th><th>Method</th><th>Razorpay ID</th><th>Status</th></tr></thead>
        <tbody><tr><td colSpan={6} className="text-center p-5 text-dim">Loading…</td></tr></tbody>
      </table>
    );
  }
  if (!rows.length) {
    return (
      <table>
        <thead><tr><th>Date</th><th>Order #</th><th>Amount</th><th>Method</th><th>Razorpay ID</th><th>Status</th></tr></thead>
        <tbody><tr><td colSpan={6}><div className="empty"><div className="ei">💳</div><h3>No payments found</h3><p>Payments will appear as orders come in</p></div></td></tr></tbody>
      </table>
    );
  }
  return (
    <table>
      <thead><tr><th>Date</th><th>Order #</th><th>Amount</th><th>Method</th><th>Razorpay ID</th><th>Status</th></tr></thead>
      <tbody>
        {rows.map((p, idx) => {
          const cls = PAY_STATUS_CLS[p.status?.toUpperCase?.() || ''] || 'bd';
          return (
            <tr key={p.id || p.razorpay_id || idx}>
              <td className="text-sm">{p.date || ''}</td>
              <td className="font-mono text-xs">{p.display_order_id || '—'}</td>
              <td>{formatINR(p.amount)}</td>
              <td className="text-sm">{p.method || '—'}</td>
              <td className="font-mono text-xs text-dim">{p.razorpay_id || '—'}</td>
              <td><span className={`badge ${cls}`}>{p.status || 'N/A'}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface PagerProps {
  page: number;
  totalPages?: number;
  hasMore?: boolean;
  onChange: (next: number) => void;
  loading: boolean;
  idPrefix: string;
}

function Pager({ page, totalPages, hasMore, onChange, loading, idPrefix }: PagerProps) {
  const atEnd = !hasMore && (!totalPages || page >= totalPages);
  return (
    <div
      id={`${idPrefix}-pag`}
      className="py-3 px-5 border-t border-rim flex items-center justify-between"
    >
      <span id={`${idPrefix}-info`} className="text-xs text-dim">
        Page {page}{totalPages ? ` of ${totalPages}` : ''}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          id={`${idPrefix}-prev`}
          className="btn-g btn-sm"
          disabled={page <= 1 || loading}
          onClick={() => onChange(page - 1)}
        >
          ← Prev
        </button>
        <button
          type="button"
          id={`${idPrefix}-next`}
          className="btn-g btn-sm"
          disabled={atEnd || loading}
          onClick={() => onChange(page + 1)}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

interface PayFilter { from: string; to: string }

export default function SettlementsSection() {
  const [settlePage, setSettlePage] = useState<number>(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const [settlePreset, setSettlePreset] = useState<SettlePreset>('this_week');
  const [settleCustomFrom, setSettleCustomFrom] = useState<string>('');
  const [settleCustomTo, setSettleCustomTo] = useState<string>('');
  // Applied custom range — only updated via the Apply button so typing a
  // partial date doesn't fire a request on every keystroke.
  const [settleCustom, setSettleCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });

  const settlementsQ = useAnalyticsFetch<SettlementsResponse | null>(
    useCallback(() => {
      const params: Record<string, string | number> = { page: settlePage, limit: SETTLE_LIMIT };
      if (settlePreset === 'custom') {
        if (settleCustom.from) params.from = new Date(`${settleCustom.from}T00:00:00`).toISOString();
        if (settleCustom.to) params.to = new Date(`${settleCustom.to}T23:59:59.999`).toISOString();
      } else {
        const { from, to } = presetRange(settlePreset);
        params.from = from;
        params.to = to;
      }
      return getSettlements(params) as Promise<SettlementsResponse | null>;
    }, [settlePage, settlePreset, settleCustom.from, settleCustom.to]),
    [settlePage, settlePreset, settleCustom.from, settleCustom.to],
  );

  const applySettleCustom = () => {
    setSettlePreset('custom');
    setSettleCustom({ from: settleCustomFrom, to: settleCustomTo });
    setSettlePage(1);
  };

  const [payPage, setPayPage] = useState<number>(1);
  const [payFromInput, setPayFromInput] = useState<string>('');
  const [payToInput, setPayToInput] = useState<string>('');
  const [payFilter, setPayFilter] = useState<PayFilter>({ from: '', to: '' });
  // Branch filter — applies immediately on change (unlike the date inputs
  // which need the Filter button). null = "All Branches" → branch_id is
  // omitted from the query, server falls back to the existing $in over
  // all the restaurant's branches. The backend also re-validates the id
  // against the restaurant's branch set, so a stale value in this state
  // can't leak cross-tenant data.
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBranches()
      .then((rows) => { if (!cancelled) setBranches(Array.isArray(rows) ? rows : []); })
      .catch(() => { /* dropdown silently degrades to "All Branches" only */ });
    return () => { cancelled = true; };
  }, []);

  const paymentsQ = useAnalyticsFetch<PaymentsResponse | null>(
    useCallback(() => {
      const params: Record<string, string | number> = { page: payPage, limit: PAY_LIMIT };
      if (payFilter.from) params.from = payFilter.from;
      if (payFilter.to) params.to = payFilter.to;
      if (selectedBranchId) params.branch_id = selectedBranchId;
      return getPayments(params) as Promise<PaymentsResponse | null>;
    }, [payPage, payFilter.from, payFilter.to, selectedBranchId]),
    [payPage, payFilter.from, payFilter.to, selectedBranchId],
  );

  const applyPayFilter = () => {
    setPayFilter({ from: payFromInput, to: payToInput });
    setPayPage(1);
  };

  const settleTotalPages = settlementsQ.data?.total_pages;
  const settleHasMore = settlementsQ.data?.has_more;
  const payTotalPages = paymentsQ.data?.total_pages;
  const payHasMore = paymentsQ.data?.has_more;

  return (
    <div>
      <div className="card mb-5">
        <div className="ch">
          <h3>Settlements</h3>
          <div className="flex gap-1.5 items-center flex-wrap">
            {SETTLE_PRESETS.map(([v, l]) => (
              <button
                key={v}
                type="button"
                className={settlePreset === v ? 'chip on' : 'chip'}
                onClick={() => { setSettlePreset(v); setSettlePage(1); }}
              >
                {l}
              </button>
            ))}
            <button
              type="button"
              id="fin-settle-custom-btn"
              className={settlePreset === 'custom' ? 'chip on' : 'chip'}
              onClick={() => { setSettlePreset('custom'); setSettlePage(1); }}
            >
              Custom Range
            </button>
            {settlePreset === 'custom' && (
              <span className="flex items-center gap-1.5">
                <input
                  type="date"
                  id="fin-settle-from"
                  value={settleCustomFrom}
                  onChange={(e) => setSettleCustomFrom(e.target.value)}
                  className="text-xs py-1 px-2 border border-rim rounded-md"
                />
                <span className="text-xs text-dim">to</span>
                <input
                  type="date"
                  id="fin-settle-to"
                  value={settleCustomTo}
                  onChange={(e) => setSettleCustomTo(e.target.value)}
                  className="text-xs py-1 px-2 border border-rim rounded-md"
                />
                <button type="button" className="btn-p btn-sm" onClick={applySettleCustom}>Apply</button>
              </span>
            )}
          </div>
        </div>
        <p className="text-sm text-dim px-5 pt-3">
          Settlements run twice a week — Thursdays (covers Mon–Wed orders) and Mondays (covers Thu–Sun orders). Payouts are processed manually within 24 hours after each settlement.
        </p>
        <div className="tbl">
          <SettlementsTable settlementsQ={settlementsQ} onView={setOpenId} />
        </div>
        {(settlementsQ.data?.settlements?.length || settlePage > 1) && (
          <Pager
            page={settlePage}
            totalPages={settleTotalPages}
            hasMore={settleHasMore}
            loading={settlementsQ.loading}
            onChange={setSettlePage}
            idPrefix="fin-settle"
          />
        )}
      </div>

      <div className="card mb-5">
        <div className="ch">
          <h3>Payments Log</h3>
          <div className="flex gap-1.5 items-center flex-wrap">
            <select
              id="fin-pay-branch"
              value={selectedBranchId ?? ''}
              onChange={(e) => {
                setSelectedBranchId(e.target.value || null);
                setPayPage(1);
              }}
              className="text-xs py-1 px-2 border border-rim rounded-md"
            >
              <option value="">All Branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <input
              type="date"
              id="fin-pay-from"
              value={payFromInput}
              onChange={(e) => setPayFromInput(e.target.value)}
              className="text-xs py-1 px-2 border border-rim rounded-md"
            />
            <input
              type="date"
              id="fin-pay-to"
              value={payToInput}
              onChange={(e) => setPayToInput(e.target.value)}
              className="text-xs py-1 px-2 border border-rim rounded-md"
            />
            <button type="button" className="btn-g btn-sm" onClick={applyPayFilter}>Filter</button>
          </div>
        </div>
        <div className="tbl">
          <PaymentsLogTable paymentsQ={paymentsQ} />
        </div>
        {(paymentsQ.data?.payments?.length || payPage > 1) && (
          <Pager
            page={payPage}
            totalPages={payTotalPages}
            hasMore={payHasMore}
            loading={paymentsQ.loading}
            onChange={setPayPage}
            idPrefix="fin-pay"
          />
        )}
      </div>

      {openId && (
        <SettlementDetailModal settlementId={openId} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}
