'use client';

import { useCallback, useEffect, useState } from 'react';
import SectionError from '../../../components/restaurant/analytics/SectionError';
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
    <span
      className="inline-block py-[0.1rem] px-2 rounded-[10px] text-[0.72rem] font-semibold uppercase tracking-[0.03em]"
      // bg / colour come from SOURCE_BADGE by source at runtime
      // (whatsapp/razorpay/3pl/catalog + slate fallback — 5 distinct
      // rgba/hex pairs).
      style={{ background: cfg.bg, color: cfg.color }}
    >{s}</span>
  );
}

function statusBadge(l: LogRow) {
  if (l.error_message) return <span className="text-red-600 text-[0.75rem] font-semibold">Error</span>;
  if (l.processed) return <span className="text-[#047857] text-[0.75rem] font-semibold">Processed</span>;
  return <span className="text-dim text-[0.75rem]">Pending</span>;
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return '—'; }
}

const TH_CLS = 'py-2 px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.35rem] px-[0.55rem] text-[0.78rem]';

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
        <div className="ch justify-between flex-wrap gap-[0.6rem]">
          <h3 className="m-0">Webhook Logs <span className="text-dim text-[0.78rem] font-medium">({total} total)</span></h3>
          <button type="button" className="btn-g btn-sm" onClick={clearFilters} disabled={loading}>Clear Filters</button>
        </div>

        <div className="flex flex-wrap gap-2 py-3 px-4 border-b border-rim">
          <select value={source} onChange={(e) => { setSource(e.target.value); setOffset(0); }} className={INPUT_CLS}>
            <option value="">All sources</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="razorpay">Razorpay</option>
            <option value="3pl">3PL</option>
            <option value="catalog">Catalog</option>
          </select>
          <select value={processed} onChange={(e) => { setProcessed(e.target.value); setOffset(0); }} className={INPUT_CLS}>
            <option value="">Processed: any</option>
            <option value="true">Processed</option>
            <option value="false">Unprocessed</option>
          </select>
          <select value={hasError} onChange={(e) => { setHasError(e.target.value); setOffset(0); }} className={INPUT_CLS}>
            <option value="">Errors: any</option>
            <option value="true">Has error</option>
            <option value="false">No error</option>
          </select>
          <input
            value={eventType}
            onChange={(e) => { setEventType(e.target.value); setOffset(0); }}
            placeholder="Event type…"
            className={`${INPUT_CLS} w-[200px]`}
          />
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setOffset(0); }} className={INPUT_CLS} />
          <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setOffset(0); }} className={INPUT_CLS} />
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink text-left text-dim text-[0.74rem]">
                  <th className={TH_CLS}>Time</th>
                  <th className={TH_CLS}>Source</th>
                  <th className={TH_CLS}>Event Type</th>
                  <th className={TH_CLS}>Phone ID</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Error</th>
                  <th className={TH_CLS}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>No logs match the filters.</td></tr>
                ) : rows.map((l) => (
                  <tr key={l.id} className="border-t border-rim">
                    <td className={`${TD_CLS} text-dim text-[0.75rem]`}>{fmtTime(l.received_at)}</td>
                    <td className={TD_CLS}>{sourceBadge(l.source)}</td>
                    <td className={`${TD_CLS} mono`}>{l.event_type || '—'}</td>
                    <td className={`${TD_CLS} text-[0.72rem] text-dim mono`}>{l.phone_number_id || '—'}</td>
                    <td className={TD_CLS}>{statusBadge(l)}</td>
                    <td className={`${TD_CLS} max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap text-red-600 text-[0.75rem]`}
                        title={l.error_message || ''}>{l.error_message || '—'}</td>
                    <td className={TD_CLS}>
                      <button type="button" className="btn-g btn-sm" onClick={() => openDetail(l.id)}>View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-between items-center py-[0.6rem] px-4 border-t border-rim">
          <button type="button" className="btn-g btn-sm" onClick={prev} disabled={offset === 0 || loading}>← Prev</button>
          <span className="text-[0.8rem] text-dim">Page {page} of {pages}</span>
          <button type="button" className="btn-g btn-sm" onClick={next} disabled={offset + LOGS_LIMIT >= total || loading}>Next →</button>
        </div>
      </div>

      {detail && (
        <div
          onClick={closeDetail}
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-neutral-0 rounded-[10px] w-full max-w-[720px] max-h-[85vh] overflow-hidden flex flex-col"
          >
            <div className="flex items-center justify-between py-[0.8rem] px-4 border-b border-rim">
              <h3 className="m-0 text-[0.95rem]">{detail.event_type || 'Log Detail'}</h3>
              <div className="flex gap-[0.4rem]">
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
            <div className="py-[0.7rem] px-4 flex gap-[0.8rem] flex-wrap text-[0.78rem] text-dim border-b border-rim">
              {detail.source && sourceBadge(detail.source)}
              {detail.received_at && <span>{fmtTime(detail.received_at)}</span>}
              {detail.phone_number_id && <span className="mono">{detail.phone_number_id}</span>}
              {detail.error_message && <span className="text-red-600">{detail.error_message}</span>}
            </div>
            <div className="overflow-y-auto p-4 bg-ink flex-1">
              {detailLoading ? (
                <div className="text-dim">Loading…</div>
              ) : detailErr ? (
                <SectionError message={detailErr} />
              ) : (
                <pre className="m-0 text-[0.78rem] whitespace-pre-wrap break-all mono">
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
