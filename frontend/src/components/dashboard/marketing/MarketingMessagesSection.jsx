import { useCallback, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch.js';
import SectionError from '../analytics/SectionError.jsx';
import { getMarketingMessages } from '../../../api/restaurant.js';

// Mirrors loadMarketingMessages() in legacy marketing.js:22-60. Legacy
// default page-size is 20 and the ledger has no in-tab date pickers (those
// are driven by setMarketingRange from the enclosing page), so we expose
// paging only.
const LIMIT = 20;

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export default function MarketingMessagesSection() {
  const [page, setPage] = useState(1);
  const { data, loading, error, refetch } = useAnalyticsFetch(
    useCallback(() => getMarketingMessages({ page, limit: LIMIT }), [page]),
    [page],
  );

  const items = data?.items || [];
  const total = Number(data?.total || 0);
  const totalCost = Number(data?.total_cost || 0);
  const pageCount = total > 0 ? Math.max(1, Math.ceil(total / LIMIT)) : 1;

  return (
    <div className="card">
      <div className="ch" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>📣 Marketing Messages</h3>
        <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', fontSize: '.8rem' }}>
          <span style={{ color: 'var(--dim)' }}>Total cost:</span>
          <strong>₹{(Math.round(totalCost * 100) / 100).toFixed(2)}</strong>
          <span style={{ color: 'var(--dim)' }}>{total} messages</span>
        </div>
      </div>
      <div className="cb" style={{ overflowX: 'auto' }}>
        {error ? (
          <SectionError message={error} onRetry={refetch} />
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.86rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--rim)', textAlign: 'left', color: 'var(--dim)', fontSize: '.78rem' }}>
                  <th style={{ padding: '.5rem .7rem' }}>Customer</th>
                  <th style={{ padding: '.5rem .7rem' }}>Phone</th>
                  <th style={{ padding: '.5rem .7rem' }}>Type</th>
                  <th style={{ padding: '.5rem .7rem' }}>Category</th>
                  <th style={{ padding: '.5rem .7rem' }}>Cost</th>
                  <th style={{ padding: '.5rem .7rem' }}>Status</th>
                  <th style={{ padding: '.5rem .7rem' }}>Sent</th>
                </tr>
              </thead>
              <tbody>
                {loading && !data ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '1.2rem', color: 'var(--dim)' }}>Loading…</td></tr>
                ) : items.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '1.2rem', color: 'var(--dim)' }}>
                    No marketing messages in this range.
                  </td></tr>
                ) : (
                  items.map((m, idx) => (
                    <tr key={m.id || m._id || idx}>
                      <td style={{ padding: '.5rem .7rem' }}>{m.customer_name || '—'}</td>
                      <td style={{ padding: '.5rem .7rem', fontFamily: 'monospace', color: 'var(--dim)' }}>
                        {m.phone || '—'}
                      </td>
                      <td style={{ padding: '.5rem .7rem' }}>{m.message_type || '—'}</td>
                      <td style={{ padding: '.5rem .7rem' }}>{m.category || '—'}</td>
                      <td style={{ padding: '.5rem .7rem' }}>₹{Number(m.cost || 0).toFixed(2)}</td>
                      <td style={{ padding: '.5rem .7rem' }}>{m.status || '—'}</td>
                      <td style={{ padding: '.5rem .7rem', color: 'var(--dim)', fontSize: '.8rem' }}>
                        {formatDate(m.sent_at)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {pageCount > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: '.5rem', marginTop: '1rem' }}>
                <button
                  type="button"
                  className="btn-g btn-sm"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  ← Prev
                </button>
                <span style={{ fontSize: '.82rem', color: 'var(--dim)', alignSelf: 'center' }}>
                  Page {page} / {pageCount}
                </span>
                <button
                  type="button"
                  className="btn-g btn-sm"
                  disabled={page >= pageCount || loading}
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
