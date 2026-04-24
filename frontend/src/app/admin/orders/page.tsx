'use client';

import type { CSSProperties, ChangeEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import SectionError from '../../../components/dashboard/analytics/SectionError';
import { getAdminOrders } from '../../../api/admin';

const ORDERS_LIMIT = 50;

interface StatusOption { value: string; label: string }

const STATUS_OPTIONS: ReadonlyArray<StatusOption> = [
  { value: '', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'PREPARING', label: 'Preparing' },
  { value: 'PACKED', label: 'Packed' },
  { value: 'DISPATCHED', label: 'Dispatched' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const STATUS_COLOR: Record<string, string> = {
  PENDING: '#f59e0b',
  CONFIRMED: '#3b82f6',
  PREPARING: '#8b5cf6',
  PACKED: 'var(--gb-indigo-500)',
  DISPATCHED: '#0ea5e9',
  DELIVERED: 'var(--gb-wa-500)',
  CANCELLED: 'var(--gb-red-500)',
};

interface AdminOrderRow {
  _id?: string;
  order_number?: string;
  business_name?: string;
  branch_name?: string;
  wa_phone?: string;
  bsuid?: string;
  total_rs?: number;
  status?: string;
  created_at?: string;
}

interface AdminOrdersResponse {
  total?: number;
  orders?: AdminOrderRow[];
}

interface StatusBadgeProps { status?: string }

function StatusBadge({ status }: StatusBadgeProps) {
  const bg = STATUS_COLOR[status || ''] || 'var(--gb-slate-500)';
  return (
    <span style={{
      background: bg, color: 'var(--gb-neutral-0)', fontSize: '.68rem', fontWeight: 700,
      padding: '.1rem .45rem', borderRadius: 4, textTransform: 'uppercase',
      letterSpacing: '.04em',
    }}>{status || '—'}</span>
  );
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

function customerLabel(o: AdminOrderRow): string {
  if (o.wa_phone) return o.wa_phone;
  if (o.bsuid) return `${String(o.bsuid).slice(0, 12)}…`;
  return '—';
}

const th: CSSProperties = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.6rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const sel: CSSProperties = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.3rem .55rem', fontSize: '.78rem' };

export default function AdminOrdersPage() {
  const [status, setStatus] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [offset, setOffset] = useState<number>(0);

  const [data, setData] = useState<AdminOrdersResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const params: Record<string, string | number> = { limit: ORDERS_LIMIT, offset };
    if (status) params.status = status;
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = `${dateTo}T23:59:59`;
    try {
      const d = (await getAdminOrders(params)) as AdminOrdersResponse | null;
      setData(d || null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [status, dateFrom, dateTo, offset]);

  useEffect(() => { load(); }, [load]);

  const total = data?.total ?? 0;
  const orders = data?.orders ?? [];
  const page = Math.floor(offset / ORDERS_LIMIT) + 1;
  const pages = Math.ceil(total / ORDERS_LIMIT) || 1;

  const onFilterChange = (setter: (v: string) => void) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { setter(e.target.value); setOffset(0); };
  const clearFilters = () => { setStatus(''); setDateFrom(''); setDateTo(''); setOffset(0); };

  return (
    <div id="pg-orders">
      <div className="card">
        <div className="ch" style={{ gap: '.6rem', flexWrap: 'wrap' }}>
          <h3>All Orders</h3>
          <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>
            {loading ? '' : `${total} total`}
          </span>
          <button type="button" className="btn-g btn-sm" style={{ marginLeft: 'auto' }} onClick={load} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>

        <div
          className="cb"
          style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid var(--rim)' }}
        >
          <span style={{ fontSize: '.74rem', color: 'var(--dim)' }}>Status:</span>
          <select value={status} onChange={onFilterChange(setStatus)} style={sel}>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input type="date" value={dateFrom} onChange={onFilterChange(setDateFrom)} style={sel} />
          <input type="date" value={dateTo} onChange={onFilterChange(setDateTo)} style={sel} />
          <button type="button" className="btn-g btn-sm" onClick={clearFilters}>Clear</button>
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', borderBottom: '1px solid var(--rim)' }}>
                  <th style={th}>Order #</th>
                  <th style={th}>Restaurant</th>
                  <th style={th}>Branch</th>
                  <th style={th}>Customer</th>
                  <th style={th}>Total</th>
                  <th style={th}>Status</th>
                  <th style={th}>Time</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} style={emptyCell}>Loading…</td></tr>
                ) : orders.length === 0 ? (
                  <tr><td colSpan={7} style={emptyCell}>No orders found</td></tr>
                ) : (
                  orders.map((o) => (
                    <tr key={o._id || o.order_number} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td style={td}><span className="mono">#{o.order_number}</span></td>
                      <td style={td}>{o.business_name || '—'}</td>
                      <td style={td}>{o.branch_name || '—'}</td>
                      <td style={{ ...td, fontSize: '.76rem' }} className="mono">
                        {customerLabel(o)}
                      </td>
                      <td style={td}><strong>₹{o.total_rs}</strong></td>
                      <td style={td}><StatusBadge status={o.status} /></td>
                      <td style={{ ...td, color: 'var(--dim)', fontSize: '.74rem' }}>
                        {fmtTime(o.created_at)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ padding: '.7rem 1rem', display: 'flex', gap: '.6rem', alignItems: 'center', borderTop: '1px solid var(--rim)' }}>
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => setOffset(Math.max(0, offset - ORDERS_LIMIT))}
            disabled={loading || offset === 0}
          >← Prev</button>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
            Page {page} / {pages}
          </span>
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => setOffset(offset + ORDERS_LIMIT)}
            disabled={loading || offset + ORDERS_LIMIT >= total}
          >Next →</button>
          <span style={{ marginLeft: 'auto', fontSize: '.78rem', color: 'var(--dim)' }}>
            {total} orders
          </span>
        </div>
      </div>
    </div>
  );
}
