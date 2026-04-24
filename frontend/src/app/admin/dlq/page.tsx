'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/dashboard/analytics/SectionError';
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
    <span style={{
      display: 'inline-block', padding: '.1rem .5rem', borderRadius: 10,
      fontSize: '.72rem', fontWeight: 600, background: cfg.bg, color: cfg.color,
      textTransform: 'uppercase', letterSpacing: '.03em',
    }}>{s || '—'}</span>
  );
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

const th: CSSProperties = { padding: '.5rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.5rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input: CSSProperties = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.35rem .55rem', fontSize: '.78rem' };

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
      <div className="stats" style={{ marginBottom: '1rem' }}>
        <StatCard label="Pending Retries" value={stats?.pending_retries ?? 0} />
        <StatCard label="In DLQ" value={stats?.in_dlq ?? 0} />
        <StatCard label="Success Rate (24h)" value={`${stats?.success_rate_24h ?? 0}%`} />
        <StatCard label="Avg Retries" value={stats?.avg_retries_before_success ?? '—'} />
      </div>
      {statsErr && <div style={{ marginBottom: '1rem' }}><SectionError message={statsErr} onRetry={loadStats} /></div>}

      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '.6rem' }}>
          <h3 style={{ margin: 0 }}>Dead Letter Queue <span style={{ color: 'var(--dim)', fontSize: '.78rem', fontWeight: 500 }}>({total} entries)</span></h3>
          <select value={source} onChange={(e) => { setSource(e.target.value); setOffset(0); }} style={input}>
            <option value="">All sources</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="razorpay">Razorpay</option>
          </select>
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={loadTable} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                  <th style={th}>Failed At</th>
                  <th style={th}>Source</th>
                  <th style={th}>Event</th>
                  <th style={th}>Retries</th>
                  <th style={th}>Last Error</th>
                  <th style={th}>History</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} style={emptyCell}>No entries in DLQ.</td></tr>
                ) : rows.map((e) => (
                  <tr key={e.id} style={{ borderTop: '1px solid var(--rim)' }}>
                    <td style={{ ...td, color: 'var(--dim)', fontSize: '.75rem' }}>{fmtTime(e.dlq_at || e.received_at)}</td>
                    <td style={td}>{sourceBadge(e.source)}</td>
                    <td style={{ ...td, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="mono">{e.event_type || '—'}</td>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 600 }}>{(e.retry_count || 0)} / {(e.max_retries || 5)}</td>
                    <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--gb-red-600)', fontSize: '.75rem' }}
                        title={e.last_error || ''}>{e.last_error || '—'}</td>
                    <td style={td}>
                      <button type="button" className="btn-g btn-sm" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                        {expanded === e.id ? 'Hide' : 'Show'}
                      </button>
                      {expanded === e.id && (
                        <div style={{ marginTop: '.4rem', maxHeight: 160, overflowY: 'auto', fontSize: '.72rem' }}>
                          {(e.error_history || []).length === 0 ? (
                            <span style={{ color: 'var(--dim)' }}>No history</span>
                          ) : (e.error_history || []).map((h, i) => (
                            <div key={i} style={{ color: 'var(--dim)', padding: '.15rem 0', borderBottom: '1px solid var(--rim)' }}>
                              #{i + 1} {fmtTime(h.attempted_at)}: {h.error}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap', display: 'flex', gap: '.3rem', alignItems: 'flex-start' }}>
                      <button type="button" className="btn-p btn-sm" onClick={() => doRetry(e.id)} disabled={busy === e.id}>Retry</button>
                      {confirmDismiss === e.id ? (
                        <>
                          <button type="button" className="btn-g btn-sm" style={{ background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)' }} onClick={() => doDismiss(e.id)} disabled={busy === e.id}>Confirm</button>
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

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '.6rem 1rem', borderTop: '1px solid var(--rim)' }}>
          <button type="button" className="btn-g btn-sm" onClick={prev} disabled={offset === 0 || loading}>← Prev</button>
          <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>Page {page} of {pages}</span>
          <button type="button" className="btn-g btn-sm" onClick={next} disabled={offset + DLQ_LIMIT >= total || loading}>Next →</button>
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
            style={{ background: 'var(--gb-neutral-0)', borderRadius: 10, width: '100%', maxWidth: 720, maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '.8rem 1rem', borderBottom: '1px solid var(--rim)' }}>
              <h3 style={{ margin: 0, fontSize: '.95rem' }}>{detail.event_type || 'DLQ Entry'}</h3>
              <button type="button" className="btn-g btn-sm" onClick={closeDetail}>✕</button>
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
