'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import { getDlqStats, getDlq, retryDlq, dismissDlq, getAdminLog } from '../../../api/admin';

const DLQ_LIMIT = 50;

interface SourceCfg { bg: string; color: string }

const SOURCE_BADGE: Record<string, SourceCfg> = {
  whatsapp: { bg: 'rgba(37,211,102,.18)', color: '#047857' },
  razorpay: { bg: 'rgba(59,130,246,.18)', color: 'var(--gb-blue-600)' },
};

interface DlqStats {
  pending_retries?: number;
  in_dlq?: number;
  success_rate_24h?: number;
  avg_retries_before_success?: number | string;
}

interface ErrorHistoryEntry {
  attempted_at?: string;
  error?: string;
}

interface DlqEntry {
  id: string;
  source?: string;
  event_type?: string;
  retry_count?: number;
  max_retries?: number;
  last_error?: string;
  error_history?: ErrorHistoryEntry[];
  dlq_at?: string;
  received_at?: string;
}

interface DlqResponse {
  entries?: DlqEntry[];
  total?: number;
}

interface DlqDetail {
  id?: string;
  event_type?: string;
  payload?: unknown;
}

function sourceBadge(src?: string) {
  const s = (src || '').toLowerCase();
  const cfg = SOURCE_BADGE[s] || { bg: 'rgba(100,116,139,.18)', color: 'var(--gb-slate-700)' };
  return (
    <span
      className="inline-block py-[0.1rem] px-2 rounded-[10px] text-[0.72rem] font-semibold uppercase tracking-[0.03em]"
      // bg / colour from SOURCE_BADGE by source at runtime
      // (whatsapp/razorpay + slate fallback — 3 distinct rgba/hex pairs).
      style={{ background: cfg.bg, color: cfg.color }}
    >{s || '—'}</span>
  );
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

const TH_CLS = 'py-2 px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.35rem] px-[0.55rem] text-[0.78rem]';

export default function AdminDlqPage() {
  const { showToast } = useToast();

  const [stats, setStats] = useState<DlqStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);

  const [rows, setRows] = useState<DlqEntry[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const [offset, setOffset] = useState<number>(0);
  const [source, setSource] = useState<string>('');

  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [detail, setDetail] = useState<DlqDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const d = (await getDlqStats()) as DlqStats | null;
      setStats(d);
      setStatsErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setStatsErr(er?.response?.data?.error || er?.message || 'Failed to load DLQ stats');
    }
  }, []);

  const loadTable = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string | number> = { limit: DLQ_LIMIT, offset };
    if (source) params.source = source;
    try {
      const d = (await getDlq(params)) as DlqResponse | null;
      setRows(d?.entries || []);
      setTotal(d?.total || 0);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setErr(er?.response?.data?.error || er?.message || 'Failed to load DLQ');
    } finally {
      setLoading(false);
    }
  }, [offset, source]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadTable(); }, [loadTable]);

  const page = Math.floor(offset / DLQ_LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(total / DLQ_LIMIT));
  const prev = () => setOffset(Math.max(0, offset - DLQ_LIMIT));
  const next = () => setOffset(offset + DLQ_LIMIT < total ? offset + DLQ_LIMIT : offset);

  const doRetry = async (id: string) => {
    setBusy(id);
    try {
      await retryDlq(id);
      showToast('Retry queued', 'success');
      await Promise.all([loadStats(), loadTable()]);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Retry failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const doDismiss = async (id: string) => {
    setBusy(id);
    try {
      await dismissDlq(id);
      showToast('Entry dismissed', 'success');
      setConfirmDismiss(null);
      await Promise.all([loadStats(), loadTable()]);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Dismiss failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const openDetail = async (id: string) => {
    setDetail({ id });
    setDetailLoading(true);
    setDetailErr(null);
    try {
      const d = (await getAdminLog(id)) as DlqDetail | null;
      setDetail(d);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setDetailErr(er?.response?.data?.error || er?.message || 'Failed to load entry');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => { setDetail(null); setDetailErr(null); };

  return (
    <div id="pg-dlq">
      <div className="stats mb-4">
        <StatCard label="Pending Retries" value={stats?.pending_retries ?? 0} />
        <StatCard label="In DLQ" value={stats?.in_dlq ?? 0} />
        <StatCard label="Success Rate (24h)" value={`${stats?.success_rate_24h ?? 0}%`} />
        <StatCard label="Avg Retries" value={stats?.avg_retries_before_success ?? '—'} />
      </div>
      {statsErr && <div className="mb-4"><SectionError message={statsErr} onRetry={loadStats} /></div>}

      <div className="card">
        <div className="ch justify-between flex-wrap gap-[0.6rem]">
          <h3 className="m-0">Dead Letter Queue <span className="text-dim text-[0.78rem] font-medium">({total} entries)</span></h3>
          <select value={source} onChange={(e) => { setSource(e.target.value); setOffset(0); }} className={INPUT_CLS}>
            <option value="">All sources</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="razorpay">Razorpay</option>
          </select>
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={loadTable} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink text-left text-dim text-[0.74rem]">
                  <th className={TH_CLS}>Failed At</th>
                  <th className={TH_CLS}>Source</th>
                  <th className={TH_CLS}>Event</th>
                  <th className={TH_CLS}>Retries</th>
                  <th className={TH_CLS}>Last Error</th>
                  <th className={TH_CLS}>History</th>
                  <th className={TH_CLS}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>No entries in DLQ.</td></tr>
                ) : rows.map((e) => (
                  <tr key={e.id} className="border-t border-rim">
                    <td className={`${TD_CLS} text-dim text-[0.75rem]`}>{fmtTime(e.dlq_at || e.received_at)}</td>
                    <td className={TD_CLS}>{sourceBadge(e.source)}</td>
                    <td className={`${TD_CLS} max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap mono`}>{e.event_type || '—'}</td>
                    <td className={`${TD_CLS} text-center font-semibold`}>{(e.retry_count || 0)} / {(e.max_retries || 5)}</td>
                    <td className={`${TD_CLS} max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap text-red-600 text-[0.75rem]`}
                        title={e.last_error || ''}>{e.last_error || '—'}</td>
                    <td className={TD_CLS}>
                      <button type="button" className="btn-g btn-sm" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                        {expanded === e.id ? 'Hide' : 'Show'}
                      </button>
                      {expanded === e.id && (
                        <div className="mt-[0.4rem] max-h-[160px] overflow-y-auto text-[0.72rem]">
                          {(e.error_history || []).length === 0 ? (
                            <span className="text-dim">No history</span>
                          ) : (e.error_history || []).map((h, i) => (
                            <div key={i} className="text-dim py-[0.15rem] border-b border-rim">
                              #{i + 1} {fmtTime(h.attempted_at)}: {h.error}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className={`${TD_CLS} whitespace-nowrap flex gap-[0.3rem] items-start`}>
                      <button type="button" className="btn-p btn-sm" onClick={() => doRetry(e.id)} disabled={busy === e.id}>Retry</button>
                      {confirmDismiss === e.id ? (
                        <>
                          <button type="button" className="btn-g btn-sm bg-red-500 text-neutral-0" onClick={() => doDismiss(e.id)} disabled={busy === e.id}>Confirm</button>
                          <button type="button" className="btn-g btn-sm" onClick={() => setConfirmDismiss(null)} disabled={busy === e.id}>Cancel</button>
                        </>
                      ) : (
                        <button type="button" className="btn-g btn-sm" onClick={() => setConfirmDismiss(e.id)} disabled={busy === e.id}>Dismiss</button>
                      )}
                      <button type="button" className="btn-g btn-sm" onClick={() => openDetail(e.id)}>View</button>
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
          <button type="button" className="btn-g btn-sm" onClick={next} disabled={offset + DLQ_LIMIT >= total || loading}>Next →</button>
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
              <h3 className="m-0 text-[0.95rem]">{detail.event_type || 'DLQ Entry'}</h3>
              <button type="button" className="btn-g btn-sm" onClick={closeDetail}>✕</button>
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
