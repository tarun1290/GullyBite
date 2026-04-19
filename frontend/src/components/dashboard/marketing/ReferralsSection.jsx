import { useCallback } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch.js';
import SectionError from '../analytics/SectionError.jsx';
import { getReferrals } from '../../../api/restaurant.js';

// Mirrors loadReferrals() in legacy restaurant.js:450-482. The summary's
// "Referral Fees Owed" card is fee + 18% GST (legacy line 457).
const STATUS_COLOR = {
  active: '#22c55e',
  converted: '#a78bfa',
  expired: '#6b7280',
};

function formatINR(n) {
  return parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function shortBsuid(b) {
  return b ? `${String(b).slice(0, 12)}…` : '';
}

export default function ReferralsSection() {
  const { data, loading, error, refetch } = useAnalyticsFetch(
    useCallback(() => getReferrals(), []),
    [],
  );

  if (error) {
    return (
      <div className="card" style={{ marginTop: '.4rem' }}>
        <div className="cb">
          <SectionError message={error} onRetry={refetch} />
        </div>
      </div>
    );
  }

  const summary = data?.summary || {};
  const referrals = data?.referrals || [];
  const total = Number(summary.total || 0);
  const converted = Number(summary.converted || 0);
  const convertedPct = total > 0 ? Math.round((converted / total) * 100) : 0;
  const feeWithGst = parseFloat(summary.total_referral_fee_rs || 0) * 1.18;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '1rem', marginBottom: '1.4rem' }}>
        <div className="card" style={{ padding: '1rem 1.2rem' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{loading && !data ? '…' : total}</div>
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: '.2rem' }}>Total Referrals</div>
        </div>
        <div className="card" style={{ padding: '1rem 1.2rem' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            {loading && !data ? '…' : `${converted}${total > 0 ? ` (${convertedPct}%)` : ''}`}
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: '.2rem' }}>Converted to Orders</div>
        </div>
        <div className="card" style={{ padding: '1rem 1.2rem' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            {loading && !data ? '…' : `₹${formatINR(summary.total_order_value_rs)}`}
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: '.2rem' }}>Total Order Value</div>
        </div>
        <div className="card" style={{ padding: '1rem 1.2rem' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#a78bfa' }}>
            {loading && !data ? '…' : `₹${formatINR(feeWithGst)}`}
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: '.2rem' }}>
            Referral Fees Owed (7.5%)
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.2rem', padding: '.85rem 1.2rem', background: '#1e1b4b', border: '1px solid #4c1d9544' }}>
        <p style={{ fontSize: '.82rem', color: '#c4b5fd', margin: 0 }}>
          When a customer is referred to you by GullyBite admin, any order they place within{' '}
          <strong>8 hours</strong> of the referral carries a <strong>7.5% referral fee</strong>{' '}
          on the order subtotal. This is settled monthly.
        </p>
      </div>

      <div className="card">
        <div className="ch"><h3>Referrals Received</h3></div>
        <div className="cb" style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--rim)' }}>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Customer</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Status</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Orders</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Order Value</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Referral Fee</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Referred On</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>Loading…</td></tr>
              ) : referrals.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>No referrals received yet</td></tr>
              ) : (
                referrals.map((r, idx) => (
                  <tr key={r.id || r._id || idx} style={{ borderBottom: '1px solid var(--rim)' }}>
                    <td style={{ padding: '.6rem 1rem' }}>
                      <div style={{ fontFamily: 'monospace', fontSize: '.8rem' }}>
                        {r.customer_wa_phone || shortBsuid(r.customer_bsuid) || '—'}
                      </div>
                      {r.customer_name && (
                        <div style={{ fontSize: '.74rem', color: 'var(--dim)' }}>{r.customer_name}</div>
                      )}
                    </td>
                    <td style={{ padding: '.6rem 1rem' }}>
                      <span style={{ color: STATUS_COLOR[r.status] || '#6b7280', fontWeight: 600, textTransform: 'capitalize', fontSize: '.8rem' }}>
                        {r.status}
                      </span>
                      {r.attribution_window_hours ? (
                        <span style={{ fontSize: '.65rem', color: 'var(--dim)', marginLeft: '.3rem' }}>
                          {r.attribution_window_hours}h window
                        </span>
                      ) : null}
                    </td>
                    <td style={{ padding: '.6rem 1rem' }}>{r.orders_count}</td>
                    <td style={{ padding: '.6rem 1rem' }}>₹{formatINR(r.total_order_value_rs)}</td>
                    <td style={{ padding: '.6rem 1rem', color: '#a78bfa', fontWeight: 600 }}>₹{formatINR(r.referral_fee_rs)}</td>
                    <td style={{ padding: '.6rem 1rem', fontSize: '.78rem', color: 'var(--dim)' }}>
                      {formatDate(r.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
