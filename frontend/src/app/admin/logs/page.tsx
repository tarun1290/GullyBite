'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import SectionError from '../../../components/dashboard/analytics/SectionError';
import { getAdminLogs, getAdminLog } from '../../../api/admin';

const LOGS_LIMIT = 50;

interface SourceCfg { bg: string; color: string }

const SOURCE_BADGE: Record<string, SourceCfg> = {
  whatsapp: { bg: 'rgba(37,211,102,.18)', color: '#047857' },
  razorpay: { bg: 'rgba(59,130,246,.18)', color: 'var(--gb-blue-600)' },
  '3pl':    { bg: 'rgba(245,158,11,.18)', color: 'var(--gb-amber-600)' },
  catalog:  { bg: 'rgba(139,92,246,.18)', color: '#6d28d9' },
};

interface LogRow {
  id: string;
  source?: string;
  event_type?: string;
  phone_number_id?: string;
  processed?: boolean;
  error_message?: string;
  received_at?: string;
}

interface LogsResponse {
  logs?: LogRow[];
  total?: number;
}

interface LogDetail {
  id?: string;
  source?: string;
  event_type?: string;
  received_at?: string;
  phone_number_id?: string;
  error_message?: string;
  payload?: unknown;
  loading?: boolean;
}

function sourceBadge(src?: string) {
  const s = (src || 'other').toLowerCase();
  const cfg = SOURCE_BADGE[s] || { bg: 'rgba(100,116,139,.18)', color: 'var(--gb-slate-700)' };
  return (
    <span style={{
      display: 'inline-block', padding: '.1rem .5rem', borderRadius: 10,
      fontSize: '.72rem', fontWeight: 600, background: cfg.bg, color: cfg.color,
      textTransform: 'uppercase', letterSpacing: '.03em',
    }}>{s}</span>
  );
}

function statusBadge(l: LogRow) {
  if (l.error_message) return <span style={{ color: 'var(--gb-red-600)', fontSize: '.75rem', fontWeight: 600 }}>Error</span>;
  if (l.processed) return <span style={{ color: '#047857', fontSize: '.75rem', fontWeight: 600 }}>Processed</span>;
  return <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>Pending</span>;
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return '—'; }
}

const th: CSSProperties = { padding: '.5rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.5rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input: CSSProperties = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.35rem .55rem', fontSize: '.78rem' };

export default function AdminLogsPage() {
  const [offset, setOffset] = useState<number>(0);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const [source, setSource] = useState<string>('');
  const [processed, setProcessed] = useState<string>('');
  const [hasError, setHasError] = useState<string>('');
  const [eventType, setEventType] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');

  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  // Drives the transient "Copied!" label flip on the modal copy
  // button. Cleared after 1.5s; closing the modal clears it too via
  // the closeDetail handler so a re-open starts fresh.
  const [copied, setCopied] = useState<boolean>(false);

  const load = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string | number> = { limit: LOGS_LIMIT, offset };
    if (source) params.source = source;
    if (processed !== '') params.processed = processed;
    if (hasError !== '') params.has_error = hasError;
    if (eventType.trim()) params.event_type = eventType.trim();
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo + 'T23:59:59';
    try {
      const d = (await getAdminLogs(params)) as LogsResponse | null;
      setRows(d?.logs || []);
      setTotal(d?.total || 0);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setErr(er?.response?.data?.error || er?.message || 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, [offset, source, processed, hasError, eventType, dateFrom, dateTo]);

  useEffect(() => {
    const timer = setTimeout(() => { load(); }, eventType ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, eventType]);

  const page = Math.floor(offset / LOGS_LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(total / LOGS_LIMIT));

  const prev = () => setOffset(Math.max(0, offset - LOGS_LIMIT));
  const next = () => setOffset(offset + LOGS_LIMIT < total ? offset + LOGS_LIMIT : offset);

  const clearFilters = () => {
    setSource(''); setProcessed(''); setHasError('');
    setEventType(''); setDateFrom(''); setDateTo('');
    setOffset(0);
  };

  const openDetail = async (id: string) => {
    setDetail({ id, loading: true });
    setDetailLoading(true);
    setDetailErr(null);
    try {
      const d = (await getAdminLog(id)) as LogDetail | null;
      setDetail(d);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setDetailErr(er?.response?.data?.error || er?.message || 'Failed to load log');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => { setDetail(null); setDetailErr(null); setCopied(false); };

  return (
    <div id="pg-logs">
      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '.6rem' }}>
          <h3 style={{ margin: 0 }}>Webhook Logs <span style={{ color: 'var(--dim)', fontSize: '.78rem', fontWeight: 500 }}>({total} total)</span></h3>
          <button type="button" className="btn-g btn-sm" onClick={clearFilters} disabled={loading}>Clear Filters</button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', padding: '.75rem 1rem', borderBottom: '1px solid var(--rim)' }}>
          <select value={source} onChange={(e) => { setSource(e.target.value); setOffset(0); }} style={input}>
            <option value="">All sources</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="razorpay">Razorpay</option>
            <option value="3pl">3PL</option>
            <option value="catalog">Catalog</option>
          </select>
          <select value={processed} onChange={(e) => { setProcessed(e.target.value); setOffset(0); }} style={input}>
            <option value="">Processed: any</option>
            <option value="true">Processed</option>
            <option value="false">Unprocessed</option>
          </select>
          <select value={hasError} onChange={(e) => { setHasError(e.target.value); setOffset(0); }} style={input}>
            <option value="">Errors: any</option>
            <option value="true">Has error</option>
            <option value="false">No error</option>
          </select>
          <input
            value={eventType}
            onChange={(e) => { setEventType(e.target.value); setOffset(0); }}
            placeholder="Event type…"
            style={{ ...input, width: 200 }}
          />
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setOffset(0); }} style={input} />
          <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setOffset(0); }} style={input} />
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                  <th style={th}>Time</th>
                  <th style={th}>Source</th>
                  <th style={th}>Event Type</th>
                  <th style={th}>Phone ID</th>
                  <th style={th}>Status</th>
                  <th style={th}>Error</th>
                  <th style={th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} style={emptyCell}>No logs match the filters.</td></tr>
                ) : rows.map((l) => (
                  <tr key={l.id} style={{ borderTop: '1px solid var(--rim)' }}>
                    <td style={{ ...td, color: 'var(--dim)', fontSize: '.75rem' }}>{fmtTime(l.received_at)}</td>
                    <td style={td}>{sourceBadge(l.source)}</td>
                    <td style={td} className="mono">{l.event_type || '—'}</td>
                    <td style={{ ...td, fontSize: '.72rem', color: 'var(--dim)' }} className="mono">{l.phone_number_id || '—'}</td>
                    <td style={td}>{statusBadge(l)}</td>
                    <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--gb-red-600)', fontSize: '.75rem' }}
                        title={l.error_message || ''}>{l.error_message || '—'}</td>
                    <td style={td}>
                      <button type="button" className="btn-g btn-sm" onClick={() => openDetail(l.id)}>View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '.6rem 1rem', borderTop: '1px solid var(--rim)' }}>
          <button type="button" className="btn-g btn-sm" onClick={prev} disabled={offset === 0 || loading}>← Prev</button>
          <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>Page {page} of {pages}</span>
          <button type="button" className="btn-g btn-sm" onClick={next} disabled={offset + LOGS_LIMIT >= total || loading}>Next →</button>
        </div>
      </div>

      {detail && (
        <div
          onClick={closeDetail}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--gb-neutral-0)', borderRadius: 10, width: '100%', maxWidth: 720,
              maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '.8rem 1rem', borderBottom: '1px solid var(--rim)' }}>
              <h3 style={{ margin: 0, fontSize: '.95rem' }}>{detail.event_type || 'Log Detail'}</h3>
              <div style={{ display: 'flex', gap: '.4rem' }}>
                <button
                  type="button"
                  className="btn-g btn-sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(JSON.stringify(detail, null, 2));
                      setCopied(true);
                      // Auto-revert after 1.5s. Guard against a stale
                      // timer overwriting a fresh copy if the user
                      // double-clicks within the window — the second
                      // click sets copied=true again, and the OLDER
                      // timer's setCopied(false) would race; the
                      // setCopied callback form keeps it idempotent.
                      setTimeout(() => setCopied(false), 1500);
                    } catch {
                      /* clipboard unavailable — silent no-op */
                    }
                  }}
                  aria-label="Copy log JSON to clipboard"
                  title="Copy full log JSON"
                >
                  {copied ? 'Copied!' : '📋'}
                </button>
                <button type="button" className="btn-g btn-sm" onClick={closeDetail}>✕</button>
              </div>
            </div>
            <div style={{ padding: '.7rem 1rem', display: 'flex', gap: '.8rem', flexWrap: 'wrap', fontSize: '.78rem', color: 'var(--dim)', borderBottom: '1px solid var(--rim)' }}>
              {detail.source && sourceBadge(detail.source)}
              {detail.received_at && <span>{fmtTime(detail.received_at)}</span>}
              {detail.phone_number_id && <span className="mono">{detail.phone_number_id}</span>}
              {detail.error_message && <span style={{ color: 'var(--gb-red-600)' }}>{detail.error_message}</span>}
            </div>
            <div style={{ overflowY: 'auto', padding: '1rem', background: 'var(--ink)', flex: 1 }}>
              {detailLoading ? (
                <div style={{ color: 'var(--dim)' }}>Loading…</div>
              ) : detailErr ? (
                <SectionError message={detailErr} />
              ) : (
                <pre style={{ margin: 0, fontSize: '.78rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }} className="mono">
                  {detail.payload ? JSON.stringify(detail.payload, null, 2) : '—'}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
