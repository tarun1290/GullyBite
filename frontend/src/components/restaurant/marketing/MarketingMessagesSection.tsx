'use client';

import { useCallback, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import PendingApprovalNotice, { isPendingApproval } from '../PendingApprovalNotice';
import { getMarketingMessages } from '../../../api/restaurant';

const LIMIT = 20;

interface MarketingMessage {
  id?: string;
  _id?: string;
  customer_name?: string;
  phone?: string;
  message_type?: string;
  category?: string;
  cost?: number | string;
  status?: string;
  sent_at?: string;
}

interface MessagesResponse {
  items?: MarketingMessage[];
  total?: number | string;
  total_cost?: number | string;
}

function formatDate(d?: string): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export default function MarketingMessagesSection() {
  const [page, setPage] = useState<number>(1);
  const { data, loading, error, refetch } = useAnalyticsFetch<MessagesResponse | null>(
    useCallback(() => getMarketingMessages({ page, limit: LIMIT }) as Promise<MessagesResponse | null>, [page]),
    [page],
  );

  const items = data?.items || [];
  const total = Number(data?.total || 0);
  const totalCost = Number(data?.total_cost || 0);
  const pageCount = total > 0 ? Math.max(1, Math.ceil(total / LIMIT)) : 1;

  if (isPendingApproval(error)) {
    return <PendingApprovalNotice feature="Marketing Messages" />;
  }

  return (
    <div className="card">
      <div className="ch flex justify-between items-center">
        <h3>📣 Marketing Messages</h3>
        <div className="flex gap-[0.6rem] items-center text-[0.8rem]">
          <span className="text-dim">Total cost:</span>
          <strong>₹{(Math.round(totalCost * 100) / 100).toFixed(2)}</strong>
          <span className="text-dim">{total} messages</span>
        </div>
      </div>
      <div className="cb overflow-x-auto">
        {error ? (
          <SectionError message={error} onRetry={refetch} />
        ) : (
          <>
            <table className="w-full border-collapse text-[0.86rem]">
              <thead>
                <tr className="border-b border-rim text-left text-dim text-[0.78rem]">
                  <th className="py-2 px-[0.7rem]">Customer</th>
                  <th className="py-2 px-[0.7rem]">Phone</th>
                  <th className="py-2 px-[0.7rem]">Type</th>
                  <th className="py-2 px-[0.7rem]">Category</th>
                  <th className="py-2 px-[0.7rem]">Cost</th>
                  <th className="py-2 px-[0.7rem]">Status</th>
                  <th className="py-2 px-[0.7rem]">Sent</th>
                </tr>
              </thead>
              <tbody>
                {loading && !data ? (
                  <tr><td colSpan={7} className="text-center p-[1.2rem] text-dim">Loading…</td></tr>
                ) : items.length === 0 ? (
                  <tr><td colSpan={7} className="text-center p-[1.2rem] text-dim">
                    No marketing messages in this range.
                  </td></tr>
                ) : (
                  items.map((m, idx) => (
                    <tr key={m.id || m._id || idx}>
                      <td className="py-2 px-[0.7rem]">{m.customer_name || '—'}</td>
                      <td className="py-2 px-[0.7rem] font-mono text-dim">
                        {m.phone || '—'}
                      </td>
                      <td className="py-2 px-[0.7rem]">{m.message_type || '—'}</td>
                      <td className="py-2 px-[0.7rem]">{m.category || '—'}</td>
                      <td className="py-2 px-[0.7rem]">₹{Number(m.cost || 0).toFixed(2)}</td>
                      <td className="py-2 px-[0.7rem]">{m.status || '—'}</td>
                      <td className="py-2 px-[0.7rem] text-dim text-[0.8rem]">
                        {formatDate(m.sent_at)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {pageCount > 1 && (
              <div className="flex justify-center gap-2 mt-4">
                <button
                  type="button"
                  className="btn-g btn-sm"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  ← Prev
                </button>
                <span className="text-[0.82rem] text-dim self-center">
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
