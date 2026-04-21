import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import StatCard from '../../components/StatCard.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import {
  getActivityStats,
  getActivityFeed,
  getWebhooksLive,
  getWebhookDetail,
  getActivityErrors,
  resolveActivity,
  getActivityForRestaurant,
  getAdminRestaurants,
} from '../../api/admin.js';

// Mirrors admin.html activity monitor (3731-4063): 4-sub tabs (feed/webhooks/
// errors/drilldown), stats row, filters with 5s polling, activity+webhook
// detail modals, per-restaurant drilldown timeline grouped by day.

const SEV_COLORS = { info: '#3b82f6', warning: '#f59e0b', error: '#ef4444', critical: 'var(--gb-red-500)' };
const SEV_BG     = { info: 'rgba(59,130,246,.08)', warning: 'rgba(245,158,11,.08)', error: 'rgba(239,68,68,.08)', critical: 'rgba(220,38,38,.12)' };

const CATEGORIES = [
  'order','menu','catalog','payment','delivery','auth',
  'customer','notification','marketing','settings','issue','directory','webhook',
];

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return '—'; }
}

function sevIcon(s) {
  return s === 'critical' ? '🔴' : s === 'error' ? '❌' : s === 'warning' ? '⚠️' : 'ℹ️';
}

export default function AdminActivity() {
  const { showToast } = useToast();
  const [sub, setSub] = useState('feed');
  const [stats, setStats] = useState(null);
  const [statsErr, setStatsErr] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [restaurants, setRestaurants] = useState([]);
  const restMap = useMemo(() => {
    const m = {};
    restaurants.forEach((r) => { m[r.id] = r.name; });
    return m;
  }, [restaurants]);

  useEffect(() => {
    (async () => {
      try {
        const list = await getAdminRestaurants();
        const items = Array.isArray(list) ? list : (list?.items || list?.restaurants || []);
        setRestaurants(items.map((r) => ({ id: r.id || r._id, name: r.business_name || r.name || r.id || r._id })));
      } catch { /* non-fatal */ }
    })();
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const s = await getActivityStats();
      setStats(s);
      setStatsErr(null);
    } catch (e) {
      setStatsErr(e?.response?.data?.error || e?.message || 'Failed to load stats');
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  return (
    <div id="pg-activity">
      <div className="stats" style={{ marginBottom: '1rem' }}>
        <StatCard label="Today" value={stats?.today ?? '—'} />
        <StatCard label="This Week" value={stats?.week ?? '—'} />
        <StatCard label="This Month" value={stats?.month ?? '—'} />
        <StatCard
          label="Error Rate"
          value={stats ? `${stats.error_rate ?? 0}%` : '—'}
        />
      </div>
      {statsErr && <div style={{ marginBottom: '1rem' }}><SectionError message={statsErr} onRetry={loadStats} /></div>}

      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '.6rem' }}>
          <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
            {['feed', 'webhooks', 'errors', 'drilldown'].map((s) => (
              <button
                key={s}
                type="button"
                className={sub === s ? 'btn-p btn-sm' : 'btn-g btn-sm'}
                onClick={() => setSub(s)}
                style={{ textTransform: 'capitalize' }}
              >{s}</button>
            ))}
          </div>
          {(sub === 'feed' || sub === 'webhooks' || sub === 'errors') && (
            <label style={{ fontSize: '.8rem', color: 'var(--dim)', display: 'flex', alignItems: 'center', gap: '.3rem' }}>
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
              Auto-refresh (5s)
            </label>
          )}
        </div>

        {sub === 'feed' && (
          <FeedTab
            autoRefresh={autoRefresh}
            restaurants={restaurants}
            restMap={restMap}
            onStatsChange={loadStats}
            onOpenDrilldown={(rid) => setSub('drilldown-' + rid)}
          />
        )}
        {sub === 'webhooks' && <WebhooksTab autoRefresh={autoRefresh} />}
        {sub === 'errors' && (
          <ErrorsTab
            autoRefresh={autoRefresh}
            restMap={restMap}
            onStatsChange={loadStats}
            onOpenDrilldown={(rid) => setSub('drilldown-' + rid)}
          />
        )}
        {sub.startsWith('drilldown') && (
          <DrilldownTab
            initialRid={sub.startsWith('drilldown-') ? sub.slice('drilldown-'.length) : ''}
            restaurants={restaurants}
            restMap={restMap}
          />
        )}
      </div>
    </div>
  );
}

// ─── FEED ────────────────────────────────────────────────────────────
function FeedTab({ autoRefresh, restaurants, restMap, onStatsChange, onOpenDrilldown }) {
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [rid, setRid] = useState('');
  const [pendingSearch, setPendingSearch] = useState('');
  const [search, setSearch] = useState('');

  const [detail, setDetail] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(pendingSearch); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [pendingSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = { page, limit: 50 };
    if (category) params.category = category;
    if (severity) params.severity = severity;
    if (rid) params.restaurant_id = rid;
    if (search.trim()) params.search = search.trim();
    try {
      const r = await getActivityFeed(params);
      setRows(r?.activities || []);
      setTotalPages(r?.pages || 1);
      setErr(null);
    } catch (e) {
      setRows([]);
      setErr(e?.response?.data?.error || e?.message || 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  }, [page, category, severity, rid, search]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => { load(); onStatsChange?.(); }, 5000);
    return () => clearInterval(t);
  }, [autoRefresh, load, onStatsChange]);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', padding: '.75rem 1rem', borderBottom: '1px solid var(--rim)' }}>
        <select value={rid} onChange={(e) => { setRid(e.target.value); setPage(1); }} style={{ ...input, minWidth: 180 }}>
          <option value="">All restaurants</option>
          {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} style={input}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }} style={input}>
          <option value="">All severities</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
          <option value="critical">Critical</option>
        </select>
        <input
          value={pendingSearch}
          onChange={(e) => setPendingSearch(e.target.value)}
          placeholder="Search…"
          style={{ ...input, width: 200 }}
        />
      </div>

      {err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
            <thead>
              <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                <th style={th}>Time</th>
                <th style={th}>Actor</th>
                <th style={th}>Action</th>
                <th style={th}>Description</th>
                <th style={th}>Severity</th>
                <th style={th}>Restaurant</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} style={emptyCell}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} style={emptyCell}>No activity matches the filters.</td></tr>
              ) : rows.map((a) => (
                <tr key={a._id} style={{ background: SEV_BG[a.severity] || '', borderTop: '1px solid var(--rim)', cursor: 'pointer' }} onClick={() => setDetail(a)}>
                  <td style={{ ...td, color: 'var(--dim)', fontSize: '.76rem', whiteSpace: 'nowrap' }}>{fmtDateTime(a.created_at)}</td>
                  <td style={td}>
                    <span style={{ background: 'rgba(79,70,229,.08)', color: 'var(--acc, #4f46e5)', padding: '.1rem .4rem', borderRadius: 4, fontSize: '.7rem', fontWeight: 600 }}>{a.actor_type}</span>{' '}
                    {a.actor_name || a.actor_id || ''}
                  </td>
                  <td style={{ ...td, fontWeight: 500 }}>{a.action}</td>
                  <td style={{ ...td, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.description || ''}>{a.description || ''}</td>
                  <td style={td}><span style={{ color: SEV_COLORS[a.severity] || 'var(--gb-slate-500)', fontWeight: 600, fontSize: '.76rem' }}>{sevIcon(a.severity)} {a.severity}</span></td>
                  <td style={{ ...td, fontSize: '.78rem' }} onClick={(e) => e.stopPropagation()}>
                    {a.restaurant_id ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); onOpenDrilldown(a.restaurant_id); }} style={{ color: 'var(--acc, #4f46e5)', fontWeight: 500, textDecoration: 'none' }}>
                        {restMap[a.restaurant_id] || a.restaurant_id}
                      </a>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={page} totalPages={totalPages} onChange={setPage} loading={loading} />

      {detail && <ActivityDetailModal activity={detail} restMap={restMap} onClose={() => setDetail(null)} />}
    </>
  );
}

// ─── WEBHOOKS ────────────────────────────────────────────────────────
function WebhooksTab({ autoRefresh }) {
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getWebhooksLive({ page, limit: 50 });
      setRows(r?.webhooks || []);
      setTotalPages(r?.pages || 1);
      setErr(null);
    } catch (e) {
      setRows([]);
      setErr(e?.response?.data?.error || e?.message || 'Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => load(), 5000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const openDetail = async (id) => {
    setDetail({ id });
    setDetailLoading(true);
    setDetailErr(null);
    try {
      const r = await getWebhookDetail(id);
      setDetail(r);
    } catch (e) {
      setDetailErr(e?.response?.data?.error || e?.message || 'Failed to load webhook');
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <>
      {err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
            <thead>
              <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                <th style={th}>Time</th>
                <th style={th}>Type</th>
                <th style={th}>Phone ID</th>
                <th style={th}>Status</th>
                <th style={th}>View</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} style={emptyCell}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={5} style={emptyCell}>No webhook logs.</td></tr>
              ) : rows.map((w) => {
                const statusColor = w.status === 'processed' ? '#047857' : w.status === 'failed' ? 'var(--gb-red-600)' : 'var(--dim)';
                return (
                  <tr key={w._id} style={{ borderTop: '1px solid var(--rim)' }}>
                    <td style={{ ...td, color: 'var(--dim)', fontSize: '.76rem', whiteSpace: 'nowrap' }}>{fmtDateTime(w.received_at || w.created_at)}</td>
                    <td style={td}>{w.type || 'message'}</td>
                    <td style={td}>{w.phone_number_id || '—'}</td>
                    <td style={{ ...td, color: statusColor, fontWeight: 600, fontSize: '.78rem' }}>{w.status || 'received'}</td>
                    <td style={td}><button type="button" className="btn-g btn-sm" onClick={() => openDetail(w._id)}>View</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} totalPages={totalPages} onChange={setPage} loading={loading} />

      {detail && (
        <div
          onClick={() => { setDetail(null); setDetailErr(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem' }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--gb-neutral-0)', borderRadius: 10, width: '100%', maxWidth: 720, maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '.8rem 1rem', borderBottom: '1px solid var(--rim)' }}>
              <h3 style={{ margin: 0, fontSize: '.95rem' }}>Webhook Detail</h3>
              <button type="button" className="btn-g btn-sm" onClick={() => { setDetail(null); setDetailErr(null); }}>✕</button>
            </div>
            <div style={{ overflowY: 'auto', padding: '1rem', background: 'var(--ink)', flex: 1 }}>
              {detailLoading ? (
                <div style={{ color: 'var(--dim)' }}>Loading…</div>
              ) : detailErr ? (
                <SectionError message={detailErr} />
              ) : (
                <pre style={{ margin: 0, fontSize: '.78rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }} className="mono">{JSON.stringify(detail, null, 2)}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── ERRORS ──────────────────────────────────────────────────────────
function ErrorsTab({ autoRefresh, restMap, onStatsChange, onOpenDrilldown }) {
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [hideResolved, setHideResolved] = useState(true);
  const [busy, setBusy] = useState(null);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getActivityErrors({ page, limit: 50 });
      setRows(r?.errors || []);
      setTotalPages(Math.ceil((r?.total || 0) / (r?.limit || 50)) || 1);
      setErr(null);
    } catch (e) {
      setRows([]);
      setErr(e?.response?.data?.error || e?.message || 'Failed to load errors');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => load(), 5000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const filtered = hideResolved ? rows.filter((e) => !e.resolved_at) : rows;
  const unresolvedCount = rows.filter((e) => !e.resolved_at).length;

  const markResolved = async (id) => {
    setBusy(id);
    try {
      await resolveActivity(id);
      showToast('Marked resolved', 'ok');
      load();
      onStatsChange?.();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Failed to resolve', 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '.6rem 1rem', borderBottom: '1px solid var(--rim)' }}>
        <label style={{ fontSize: '.8rem', color: 'var(--dim)', display: 'flex', alignItems: 'center', gap: '.3rem' }}>
          <input type="checkbox" checked={hideResolved} onChange={(e) => setHideResolved(e.target.checked)} />
          Hide resolved
        </label>
        <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>Unresolved: <strong>{unresolvedCount}</strong></span>
      </div>

      {err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
            <thead>
              <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                <th style={th}>Time</th>
                <th style={th}>Action</th>
                <th style={th}>Description</th>
                <th style={th}>Actor</th>
                <th style={th}>Restaurant</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} style={emptyCell}>Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} style={emptyCell}>No errors found.</td></tr>
              ) : filtered.map((e) => (
                <tr key={e._id} style={{ background: e.resolved_at ? 'rgba(22,163,74,.04)' : 'rgba(239,68,68,.05)', borderTop: '1px solid var(--rim)' }}>
                  <td style={{ ...td, color: 'var(--dim)', fontSize: '.76rem', whiteSpace: 'nowrap' }}>{fmtDateTime(e.created_at)}</td>
                  <td style={{ ...td, fontWeight: 500 }}>{sevIcon(e.severity)} {e.action}</td>
                  <td style={{ ...td, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.description || ''}>{e.description || ''}</td>
                  <td style={td}>{e.actor_name || e.actor_type || '—'}</td>
                  <td style={{ ...td, fontSize: '.78rem' }}>
                    {e.restaurant_id ? (
                      <a href="#" onClick={(ev) => { ev.preventDefault(); onOpenDrilldown(e.restaurant_id); }} style={{ color: 'var(--acc, #4f46e5)', textDecoration: 'none' }}>
                        {restMap[e.restaurant_id] || e.restaurant_id}
                      </a>
                    ) : '—'}
                  </td>
                  <td style={td}>
                    {e.resolved_at ? (
                      <span style={{ color: '#047857', fontSize: '.76rem', fontWeight: 600 }}>✅ Resolved</span>
                    ) : (
                      <button type="button" className="btn-g btn-sm" onClick={() => markResolved(e._id)} disabled={busy === e._id}>
                        {busy === e._id ? '…' : 'Mark Resolved'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={page} totalPages={totalPages} onChange={setPage} loading={loading} />
    </>
  );
}

// ─── DRILLDOWN ───────────────────────────────────────────────────────
function DrilldownTab({ initialRid, restaurants, restMap }) {
  const [rid, setRid] = useState(initialRid || '');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [timeline, setTimeline] = useState([]);
  const [summary, setSummary] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    if (!rid) { setTimeline([]); setSummary(0); return; }
    setLoading(true);
    const params = { page, limit: 50 };
    if (category) params.category = category;
    try {
      const [sumRes, tlRes] = await Promise.all([
        getActivityForRestaurant(rid, { limit: 1 }),
        getActivityForRestaurant(rid, params),
      ]);
      setSummary(sumRes?.total || 0);
      setTimeline(tlRes?.activities || []);
      setTotalPages(tlRes?.pages || 1);
      setErr(null);
    } catch (e) {
      setTimeline([]);
      setErr(e?.response?.data?.error || e?.message || 'Failed to load timeline');
    } finally {
      setLoading(false);
    }
  }, [rid, category, page]);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const groups = {};
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    timeline.forEach((a) => {
      const d = new Date(a.created_at).toDateString();
      const label = d === today ? 'Today' : d === yesterday ? 'Yesterday' :
        new Date(a.created_at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      if (!groups[label]) groups[label] = [];
      groups[label].push(a);
    });
    return groups;
  }, [timeline]);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', padding: '.75rem 1rem', borderBottom: '1px solid var(--rim)' }}>
        <select value={rid} onChange={(e) => { setRid(e.target.value); setPage(1); }} style={{ ...input, minWidth: 220 }}>
          <option value="">Select a restaurant…</option>
          {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} style={input}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {!rid ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>Select a restaurant to view its activity timeline.</div>
      ) : err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <div style={{ padding: '1rem' }}>
          <div style={{ background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 8, padding: '.8rem', marginBottom: '1rem' }}>
            <span style={{ fontSize: '1.05rem', fontWeight: 700 }}>{restMap[rid] || rid}</span>
            <span style={{ color: 'var(--dim)', fontSize: '.82rem', marginLeft: '.8rem' }}>{summary} total events</span>
          </div>
          {loading ? (
            <div style={{ color: 'var(--dim)', textAlign: 'center', padding: '2rem' }}>Loading…</div>
          ) : timeline.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--dim)' }}>No activity found for this restaurant.</div>
          ) : Object.entries(grouped).map(([label, items]) => (
            <div key={label} style={{ marginBottom: '1.2rem' }}>
              <div style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '.5rem', paddingBottom: '.3rem', borderBottom: '1px solid var(--rim)' }}>{label}</div>
              {items.map((a) => (
                <div
                  key={a._id}
                  onClick={() => setDetail(a)}
                  style={{ display: 'flex', gap: '.6rem', alignItems: 'flex-start', padding: '.4rem 0', borderBottom: '1px solid rgba(226,232,240,.5)', cursor: 'pointer' }}
                >
                  <span style={{ fontSize: '.76rem', color: 'var(--dim)', whiteSpace: 'nowrap', minWidth: 70 }}>
                    {new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span style={{ fontSize: '.82rem' }}>{sevIcon(a.severity)}</span>
                  <span style={{ background: 'rgba(79,70,229,.06)', color: 'var(--acc, #4f46e5)', padding: '.1rem .35rem', borderRadius: 4, fontSize: '.68rem', fontWeight: 600 }}>{a.category || 'general'}</span>
                  <span style={{ fontSize: '.82rem', fontWeight: 500, color: SEV_COLORS[a.severity] || 'var(--gb-slate-500)' }}>{a.action}</span>
                  <span style={{ fontSize: '.8rem', color: 'var(--dim)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.description || ''}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <Pager page={page} totalPages={totalPages} onChange={setPage} loading={loading} />

      {detail && <ActivityDetailModal activity={detail} restMap={restMap} onClose={() => setDetail(null)} />}
    </>
  );
}

// ─── Shared widgets ──────────────────────────────────────────────────
function Pager({ page, totalPages, onChange, loading }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '.6rem 1rem', borderTop: '1px solid var(--rim)' }}>
      <button type="button" className="btn-g btn-sm" onClick={() => onChange(Math.max(1, page - 1))} disabled={page <= 1 || loading}>← Prev</button>
      <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>Page {page} of {totalPages}</span>
      <button type="button" className="btn-g btn-sm" onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages || loading}>Next →</button>
    </div>
  );
}

function ActivityDetailModal({ activity: a, restMap, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem' }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--gb-neutral-0)', borderRadius: 10, width: '100%', maxWidth: 640, maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '.8rem 1rem', borderBottom: '1px solid var(--rim)' }}>
          <h3 style={{ margin: 0, fontSize: '.95rem' }}>Activity Detail</h3>
          <button type="button" className="btn-g btn-sm" onClick={onClose}>✕</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '1rem', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '.3rem .8rem', marginBottom: '.8rem', fontSize: '.82rem' }}>
            <span style={{ color: 'var(--dim)' }}>Time:</span><span>{new Date(a.created_at).toLocaleString()}</span>
            <span style={{ color: 'var(--dim)' }}>Action:</span><span style={{ fontWeight: 600 }}>{a.action}</span>
            <span style={{ color: 'var(--dim)' }}>Category:</span><span>{a.category || ''}</span>
            <span style={{ color: 'var(--dim)' }}>Severity:</span><span style={{ color: SEV_COLORS[a.severity] || 'inherit', fontWeight: 600 }}>{a.severity}</span>
            <span style={{ color: 'var(--dim)' }}>Actor:</span><span>{a.actor_type} — {a.actor_name || a.actor_id || 'N/A'}</span>
            <span style={{ color: 'var(--dim)' }}>Restaurant:</span><span>{a.restaurant_id ? (restMap[a.restaurant_id] || a.restaurant_id) : 'N/A'}</span>
            {a.resource_type && <>
              <span style={{ color: 'var(--dim)' }}>Resource:</span><span>{a.resource_type}{a.resource_id ? ' #' + a.resource_id : ''}</span>
            </>}
          </div>
          <div style={{ marginBottom: '.6rem', fontSize: '.85rem' }}>
            <strong>Description:</strong><br />{a.description || 'No description'}
          </div>
          {a.metadata && (
            <div>
              <strong style={{ fontSize: '.85rem' }}>Metadata:</strong>
              <pre style={{ background: 'var(--ink)', padding: '.75rem', borderRadius: 6, fontSize: '.78rem', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: '.3rem' }} className="mono">
                {JSON.stringify(a.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const th = { padding: '.5rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td = { padding: '.5rem .7rem', verticalAlign: 'top' };
const emptyCell = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.35rem .55rem', fontSize: '.78rem' };
