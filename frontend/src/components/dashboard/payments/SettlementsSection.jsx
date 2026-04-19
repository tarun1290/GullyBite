import { useCallback, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch.js';
import SectionError from '../analytics/SectionError.jsx';
import SettlementDetailModal from './SettlementDetailModal.jsx';
import { getSettlements, getPayments } from '../../../api/restaurant.js';

// Mirrors loadFinSettlements() + loadFinPayments() in legacy
// payments.js:177-357. Settlements list + payments-log are both
// paginated with limit 10/15 and gate Next via has_more || total_pages.
const SETTLE_LIMIT = 10;
const PAY_LIMIT = 15;

const STATUS_CLS = { PAID: 'bg', PENDING: 'ba', PROCESSING: 'bb', FAILED: 'br' };
const PAY_STATUS_CLS = { CAPTURED: 'bg', SUCCESS: 'bg', PENDING: 'ba', FAILED: 'br', REFUNDED: 'bv' };

function formatINR(n) {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

function SettlementsTable({ settlementsQ, onView }) {
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
          const cls = STATUS_CLS[s.payout_status?.toUpperCase?.()] || 'bd';
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

function PaymentsLogTable({ paymentsQ }) {
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
          const cls = PAY_STATUS_CLS[p.status?.toUpperCase?.()] || 'bd';
          return (
            <tr key={p.id || p.razorpay_id || idx}>
              <td style={{ fontSize: '.78rem' }}>{p.date || ''}</td>
              <td style={{ fontFamily: 'monospace', fontSize: '.75rem' }}>{p.order_number || '—'}</td>
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

function Pager({ page, totalPages, hasMore, onChange, loading, idPrefix }) {
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

export default function SettlementsSection() {
  const [settlePage, setSettlePage] = useState(1);
  const [openId, setOpenId] = useState(null);

  const settlementsQ = useAnalyticsFetch(
    useCallback(() => getSettlements({ page: settlePage, limit: SETTLE_LIMIT }), [settlePage]),
    [settlePage],
  );

  const [payPage, setPayPage] = useState(1);
  const [payFromInput, setPayFromInput] = useState('');
  const [payToInput, setPayToInput] = useState('');
  const [payFilter, setPayFilter] = useState({ from: '', to: '' });

  const paymentsQ = useAnalyticsFetch(
    useCallback(() => {
      const params = { page: payPage, limit: PAY_LIMIT };
      if (payFilter.from) params.from = payFilter.from;
      if (payFilter.to) params.to = payFilter.to;
      return getPayments(params);
    }, [payPage, payFilter.from, payFilter.to]),
    [payPage, payFilter.from, payFilter.to],
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
          <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
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
