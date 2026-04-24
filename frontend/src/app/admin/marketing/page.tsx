'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import SectionError from '../../../components/dashboard/analytics/SectionError';
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

const th: CSSProperties = { padding: '.5rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.5rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input: CSSProperties = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.4rem .6rem', fontSize: '.8rem' };

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
        <div className="ch" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '.6rem' }}>
          <h3 style={{ margin: 0 }}>Marketing Messages</h3>
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={pendingRid}
              onChange={(e) => setPendingRid(e.target.value)}
              placeholder="Restaurant ID (optional)"
              style={{ ...input, width: 220 }}
            />
            <input
              type="date"
              value={pendingFrom}
              onChange={(e) => setPendingFrom(e.target.value)}
              style={input}
            />
            <input
              type="date"
              value={pendingTo}
              onChange={(e) => setPendingTo(e.target.value)}
              style={input}
            />
            <button type="button" className="btn-p btn-sm" onClick={applyFilters} disabled={loading}>
              Apply
            </button>
          </div>
        </div>

        <div style={{
          display: 'flex', gap: '1rem', padding: '.8rem 1rem',
          borderBottom: '1px solid var(--rim)', background: 'var(--ink)',
          fontSize: '.82rem',
        }}>
          <div>
            <span style={{ color: 'var(--dim)' }}>Total revenue from messages:</span>{' '}
            <strong>₹{Number(totalRevenue || 0).toFixed(2)}</strong>
          </div>
          <div>
            <span style={{ color: 'var(--dim)' }}>Count:</span>{' '}
            <strong>{totalCount}</strong>
          </div>
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.75rem' }}>
                  <th style={th}>Restaurant</th>
                  <th style={th}>WABA ID</th>
                  <th style={th}>Customer</th>
                  <th style={th}>Phone</th>
                  <th style={th}>Type</th>
                  <th style={th}>Category</th>
                  <th style={th}>Cost</th>
                  <th style={th}>Sent</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8} style={emptyCell}>No marketing messages in this range.</td></tr>
                ) : rows.map((m, i) => (
                  <tr key={m.id || i} style={{ borderTop: '1px solid var(--rim)' }}>
                    <td style={{ ...td, fontSize: '.75rem' }} className="mono">{m.restaurant_id || '—'}</td>
                    <td style={{ ...td, fontSize: '.75rem' }} className="mono">{m.waba_id || '—'}</td>
                    <td style={td}>{m.customer_name || '—'}</td>
                    <td style={td} className="mono">{m.phone || '—'}</td>
                    <td style={td}>{m.message_type || '—'}</td>
                    <td style={td}>{m.category || '—'}</td>
                    <td style={td}>₹{Number(m.cost || 0).toFixed(2)}</td>
                    <td style={{ ...td, color: 'var(--dim)', fontSize: '.78rem' }}>{fmtDateTime(m.sent_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '.6rem 1rem', borderTop: '1px solid var(--rim)',
        }}>
          <button type="button" className="btn-g btn-sm" onClick={prevPage} disabled={page <= 1 || loading}>
            ← Prev
          </button>
          <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>Page {page} of {totalPages}</span>
          <button type="button" className="btn-g btn-sm" onClick={nextPage} disabled={page >= totalPages || loading}>
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
