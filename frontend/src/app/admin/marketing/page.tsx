'use client';

import { useCallback, useEffect, useState } from 'react';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import { getAdminMarketingMessages } from '../../../api/admin';

const LIMIT = 20;

interface MarketingMsg {
  id?: string;
  restaurant_id?: string;
  waba_id?: string;
  customer_name?: string;
  phone?: string;
  message_type?: string;
  category?: string;
  cost?: number | string;
  sent_at?: string;
}

interface MarketingResponse {
  items?: MarketingMsg[];
  total?: number;
  total_revenue?: number | string;
  total_cost?: number | string;
  limit?: number;
}

function fmtDateTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

const TH_CLS = 'py-2 px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.4rem] px-[0.6rem] text-[0.8rem]';

export default function AdminMarketingPage() {
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [totalRevenue, setTotalRevenue] = useState<number | string>(0);
  const [rows, setRows] = useState<MarketingMsg[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const [pendingRid, setPendingRid] = useState<string>('');
  const [pendingFrom, setPendingFrom] = useState<string>('');
  const [pendingTo, setPendingTo] = useState<string>('');
  const [rid, setRid] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string | number> = { page, limit: LIMIT };
    if (rid) params.restaurant_id = rid;
    if (fromDate) params.from = fromDate;
    if (toDate) params.to = toDate;
    try {
      const d = (await getAdminMarketingMessages(params)) as MarketingResponse | null;
      setRows(d?.items || []);
      setTotalCount(d?.total || 0);
      setTotalRevenue(d?.total_revenue ?? d?.total_cost ?? 0);
      const pages = Math.max(1, Math.ceil((d?.total || 0) / (d?.limit || LIMIT)));
      setTotalPages(pages);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setErr(er?.response?.data?.error || er?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [page, rid, fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  const applyFilters = () => {
    setRid(pendingRid.trim());
    setFromDate(pendingFrom);
    setToDate(pendingTo);
    setPage(1);
  };

  const prevPage = () => setPage(Math.max(1, page - 1));
  const nextPage = () => setPage(Math.min(totalPages, page + 1));

  return (
    <div id="pg-marketing">
      <div className="card">
        <div className="ch justify-between flex-wrap gap-[0.6rem]">
          <h3 className="m-0">Marketing Messages</h3>
          <div className="flex gap-2 items-center flex-wrap">
            <input
              value={pendingRid}
              onChange={(e) => setPendingRid(e.target.value)}
              placeholder="Restaurant ID (optional)"
              className={`${INPUT_CLS} w-[220px]`}
            />
            <input
              type="date"
              value={pendingFrom}
              onChange={(e) => setPendingFrom(e.target.value)}
              className={INPUT_CLS}
            />
            <input
              type="date"
              value={pendingTo}
              onChange={(e) => setPendingTo(e.target.value)}
              className={INPUT_CLS}
            />
            <button type="button" className="btn-p btn-sm" onClick={applyFilters} disabled={loading}>
              Apply
            </button>
          </div>
        </div>

        <div className="flex gap-4 py-[0.8rem] px-4 border-b border-rim bg-ink text-[0.82rem]">
          <div>
            <span className="text-dim">Total revenue from messages:</span>{' '}
            <strong>₹{Number(totalRevenue || 0).toFixed(2)}</strong>
          </div>
          <div>
            <span className="text-dim">Count:</span>{' '}
            <strong>{totalCount}</strong>
          </div>
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink text-left text-dim text-[0.75rem]">
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>WABA ID</th>
                  <th className={TH_CLS}>Customer</th>
                  <th className={TH_CLS}>Phone</th>
                  <th className={TH_CLS}>Type</th>
                  <th className={TH_CLS}>Category</th>
                  <th className={TH_CLS}>Cost</th>
                  <th className={TH_CLS}>Sent</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8} className={EMPTY_CLS}>No marketing messages in this range.</td></tr>
                ) : rows.map((m, i) => (
                  <tr key={m.id || i} className="border-t border-rim">
                    <td className={`${TD_CLS} text-[0.75rem] mono`}>{m.restaurant_id || '—'}</td>
                    <td className={`${TD_CLS} text-[0.75rem] mono`}>{m.waba_id || '—'}</td>
                    <td className={TD_CLS}>{m.customer_name || '—'}</td>
                    <td className={`${TD_CLS} mono`}>{m.phone || '—'}</td>
                    <td className={TD_CLS}>{m.message_type || '—'}</td>
                    <td className={TD_CLS}>{m.category || '—'}</td>
                    <td className={TD_CLS}>₹{Number(m.cost || 0).toFixed(2)}</td>
                    <td className={`${TD_CLS} text-dim text-[0.78rem]`}>{fmtDateTime(m.sent_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-between items-center py-[0.6rem] px-4 border-t border-rim">
          <button type="button" className="btn-g btn-sm" onClick={prevPage} disabled={page <= 1 || loading}>
            ← Prev
          </button>
          <span className="text-[0.8rem] text-dim">Page {page} of {totalPages}</span>
          <button type="button" className="btn-g btn-sm" onClick={nextPage} disabled={page >= totalPages || loading}>
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
