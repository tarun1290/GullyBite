'use client';

import { useCallback, useEffect, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import SettlementDetailModal from './SettlementDetailModal';
import { getSettlements, getPayments, getBranches } from '../../../api/restaurant';
import type { Branch } from '../../../types';

const SETTLE_LIMIT = 10;
const PAY_LIMIT = 15;

const STATUS_CLS: Record<string, string> = { PAID: 'bg', PENDING: 'ba', PROCESSING: 'bb', FAILED: 'br' };
const PAY_STATUS_CLS: Record<string, string> = { CAPTURED: 'bg', SUCCESS: 'bg', PENDING: 'ba', FAILED: 'br', REFUNDED: 'bv' };

interface Settlement {
  id: string;
  period_start?: string;
  period_end?: string;
  gross_revenue?: number | string;
  total_deductions?: number | string;
  tds?: number | string;
  net_payout?: number | string;
  payout_status?: string;
  utr?: string;
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

function SettlementsTable({ settlementsQ, onView }: SettlementsTableProps) {
  const rows = settlementsQ.data?.settlements || [];
  if (settlementsQ.error) {
    return <div style={{ padding: '1rem' }}><SectionError message={settlementsQ.error} onRetry={settlementsQ.refetch} /></div>;
  }
  if (settlementsQ.loading && !settlementsQ.data) {
    return (
      <table>
        <thead><tr><th>Period</th><th>Gross</th><th>Deductions</th><th>TDS</th><th>Net</th><th>Status</th><th>UTR</th><th /></tr></thead>
        <tbody><tr><td colSpan={8} style={{ textAlign: 'center', padding: '1.2rem', color: 'var(--dim)' }}>Loading…</td></tr></tbody>
      </table>
    );
  }
  if (!rows.length) {
    return (
      <table>
        <thead><tr><th>Period</th><th>Gross</th><th>Deductions</th><th>TDS</th><th>Net</th><th>Status</th><th>UTR</th><th /></tr></thead>
        <tbody><tr><td colSpan={8}><div className="empty"><div className="ei">💰</div><h3>No settlements yet</h3><p>Settlements appear after your first payout cycle</p></div></td></tr></tbody>
      </table>
    );
  }
  return (
    <table>
      <thead><tr><th>Period</th><th>Gross</th><th>Deductions</th><th>TDS</th><th>Net</th><th>Status</th><th>UTR</th><th /></tr></thead>
      <tbody>
        {rows.map((s) => {
          const cls = STATUS_CLS[s.payout_status?.toUpperCase?.() || ''] || 'bd';
          return (
            <tr key={s.id}>
              <td style={{ fontSize: '.8rem' }}>{s.period_start || ''} → {s.period_end || ''}</td>
              <td>{formatINR(s.gross_revenue)}</td>
              <td style={{ color: 'var(--red,#dc2626)' }}>{formatINR(s.total_deductions)}</td>
              <td>{formatINR(s.tds)}</td>
              <td><strong>{formatINR(s.net_payout)}</strong></td>
              <td><span className={`badge ${cls}`}>{s.payout_status || 'N/A'}</span></td>
              <td style={{ fontSize: '.72rem', color: 'var(--dim)', fontFamily: 'monospace' }}>{s.utr || '—'}</td>
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
    return <div style={{ padding: '1rem' }}><SectionError message={paymentsQ.error} onRetry={paymentsQ.refetch} /></div>;
  }
  if (paymentsQ.loading && !paymentsQ.data) {
    return (
      <table>
        <thead><tr><th>Date</th><th>Order #</th><th>Amount</th><th>Method</th><th>Razorpay ID</th><th>Status</th></tr></thead>
        <tbody><tr><td colSpan={6} style={{ textAlign: 'center', padding: '1.2rem', color: 'var(--dim)' }}>Loading…</td></tr></tbody>
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
              <td style={{ fontSize: '.78rem' }}>{p.date || ''}</td>
              <td style={{ fontFamily: 'monospace', fontSize: '.75rem' }}>{p.display_order_id || '—'}</td>
              <td>{formatINR(p.amount)}</td>
              <td style={{ fontSize: '.78rem' }}>{p.method || '—'}</td>
              <td style={{ fontFamily: 'monospace', fontSize: '.72rem', color: 'var(--dim)' }}>{p.razorpay_id || '—'}</td>
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
      style={{ padding: '.7rem 1.2rem', borderTop: '1px solid var(--rim)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
    >
      <span id={`${idPrefix}-info`} style={{ fontSize: '.75rem', color: 'var(--dim)' }}>
        Page {page}{totalPages ? ` of ${totalPages}` : ''}
      </span>
      <div style={{ display: 'flex', gap: '.3rem' }}>
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

  const settlementsQ = useAnalyticsFetch<SettlementsResponse | null>(
    useCallback(() => getSettlements({ page: settlePage, limit: SETTLE_LIMIT }) as Promise<SettlementsResponse | null>, [settlePage]),
    [settlePage],
  );

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
      <div className="card" style={{ marginBottom: '1.2rem' }}>
        <div className="ch"><h3>Settlements</h3></div>
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

      <div className="card" style={{ marginBottom: '1.2rem' }}>
        <div className="ch">
          <h3>Payments Log</h3>
          <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              id="fin-pay-branch"
              value={selectedBranchId ?? ''}
              onChange={(e) => {
                setSelectedBranchId(e.target.value || null);
                setPayPage(1);
              }}
              style={{ fontSize: '.75rem', padding: '.28rem .5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
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
              style={{ fontSize: '.75rem', padding: '.28rem .5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
            />
            <input
              type="date"
              id="fin-pay-to"
              value={payToInput}
              onChange={(e) => setPayToInput(e.target.value)}
              style={{ fontSize: '.75rem', padding: '.28rem .5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
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
