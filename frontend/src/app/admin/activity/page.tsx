'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getActivityStats,
  getActivityFeed,
  getWebhooksLive,
  getWebhookDetail,
  getActivityErrors,
  resolveActivity,
  getActivityForRestaurant,
  getAdminRestaurants,
} from '../../../api/admin';

const SEV_COLORS: Record<string, string> = { info: '#3b82f6', warning: '#f59e0b', error: '#ef4444', critical: 'var(--gb-red-500)' };
const SEV_BG: Record<string, string>     = { info: 'rgba(59,130,246,.08)', warning: 'rgba(245,158,11,.08)', error: 'rgba(239,68,68,.08)', critical: 'rgba(220,38,38,.12)' };

const CATEGORIES = [
  'order','menu','catalog','payment','delivery','auth',
  'customer','notification','marketing','settings','issue','directory','webhook',
] as const;

interface ActivityStats {
  today?: number;
  week?: number;
  month?: number;
  error_rate?: number;
}

interface RestaurantLite { id: string; name: string }

interface AdminRestaurantApiRow {
  id?: string;
  _id?: string;
  business_name?: string;
  name?: string;
}

interface AdminRestaurantsListEnvelope {
  items?: AdminRestaurantApiRow[];
  restaurants?: AdminRestaurantApiRow[];
}

interface ActivityRow {
  _id: string;
  created_at?: string;
  actor_type?: string;
  actor_name?: string;
  actor_id?: string;
  action?: string;
  description?: string;
  severity?: string;
  restaurant_id?: string;
  category?: string;
  resource_type?: string;
  resource_id?: string;
  metadata?: unknown;
  resolved_at?: string;
}

interface ActivityFeedResponse {
  activities?: ActivityRow[];
  pages?: number;
  total?: number;
  limit?: number;
}

interface WebhookRow {
  _id: string;
  type?: string;
  phone_number_id?: string;
  status?: string;
  received_at?: string;
  created_at?: string;
}

interface WebhooksResponse {
  webhooks?: WebhookRow[];
  pages?: number;
}

interface ErrorsResponse {
  errors?: ActivityRow[];
  total?: number;
  limit?: number;
}

function fmtDateTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return '—'; }
}

function sevIcon(s?: string): string {
  return s === 'critical' ? '🔴' : s === 'error' ? '❌' : s === 'warning' ? '⚠️' : 'ℹ️';
}

const TH_CLS = 'py-2 px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.35rem] px-[0.55rem] text-[0.78rem]';

export default function AdminActivityPage() {
  const [sub, setSub] = useState<string>('feed');
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const [restaurants, setRestaurants] = useState<RestaurantLite[]>([]);
  const restMap = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    restaurants.forEach((r) => { m[r.id] = r.name; });
    return m;
  }, [restaurants]);

  useEffect(() => {
    (async () => {
      try {
        const list = (await getAdminRestaurants()) as AdminRestaurantApiRow[] | AdminRestaurantsListEnvelope | null;
        const items: AdminRestaurantApiRow[] = Array.isArray(list)
          ? list
          : (list?.items || list?.restaurants || []);
        setRestaurants(items.map((r) => ({ id: (r.id || r._id) || '', name: r.business_name || r.name || r.id || r._id || '' })));
      } catch { /* non-fatal */ }
    })();
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const s = (await getActivityStats()) as ActivityStats | null;
      setStats(s);
      setStatsErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setStatsErr(er?.response?.data?.error || er?.message || 'Failed to load stats');
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  return (
    <div id="pg-activity">
      <div className="stats mb-4">
        <StatCard label="Today" value={stats?.today ?? '—'} />
        <StatCard label="This Week" value={stats?.week ?? '—'} />
        <StatCard label="This Month" value={stats?.month ?? '—'} />
        <StatCard
          label="Error Rate"
          value={stats ? `${stats.error_rate ?? 0}%` : '—'}
        />
      </div>
      {statsErr && <div className="mb-4"><SectionError message={statsErr} onRetry={loadStats} /></div>}

      <div className="card">
        <div className="ch justify-between flex-wrap gap-[0.6rem]">
          <div className="flex gap-[0.4rem] flex-wrap">
            {['feed', 'webhooks', 'errors', 'drilldown'].map((s) => (
              <button
                key={s}
                type="button"
                className={`${sub === s ? 'btn-p btn-sm' : 'btn-g btn-sm'} capitalize`}
                onClick={() => setSub(s)}
              >{s}</button>
            ))}
          </div>
          {(sub === 'feed' || sub === 'webhooks' || sub === 'errors') && (
            <label className="text-[0.8rem] text-dim flex items-center gap-[0.3rem]">
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

interface FeedTabProps {
  autoRefresh: boolean;
  restaurants: RestaurantLite[];
  restMap: Record<string, string>;
  onStatsChange: () => void;
  onOpenDrilldown: (rid: string) => void;
}

function FeedTab({ autoRefresh, restaurants, restMap, onStatsChange, onOpenDrilldown }: FeedTabProps): ReactNode {
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const [category, setCategory] = useState<string>('');
  const [severity, setSeverity] = useState<string>('');
  const [rid, setRid] = useState<string>('');
  const [pendingSearch, setPendingSearch] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  const [detail, setDetail] = useState<ActivityRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(pendingSearch); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [pendingSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string | number> = { page, limit: 50 };
    if (category) params.category = category;
    if (severity) params.severity = severity;
    if (rid) params.restaurant_id = rid;
    if (search.trim()) params.search = search.trim();
    try {
      const r = (await getActivityFeed(params)) as ActivityFeedResponse | null;
      setRows(r?.activities || []);
      setTotalPages(r?.pages || 1);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setErr(er?.response?.data?.error || er?.message || 'Failed to load activity');
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
      <div className="flex flex-wrap gap-2 py-3 px-4 border-b border-rim">
        <select value={rid} onChange={(e) => { setRid(e.target.value); setPage(1); }} className={`${INPUT_CLS} min-w-[180px]`}>
          <option value="">All restaurants</option>
          {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} className={INPUT_CLS}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }} className={INPUT_CLS}>
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
          className={`${INPUT_CLS} w-[200px]`}
        />
      </div>

      {err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.82rem]">
            <thead>
              <tr className="bg-ink text-left text-dim text-[0.74rem]">
                <th className={TH_CLS}>Time</th>
                <th className={TH_CLS}>Actor</th>
                <th className={TH_CLS}>Action</th>
                <th className={TH_CLS}>Description</th>
                <th className={TH_CLS}>Severity</th>
                <th className={TH_CLS}>Restaurant</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className={EMPTY_CLS}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className={EMPTY_CLS}>No activity matches the filters.</td></tr>
              ) : rows.map((a) => (
                <tr
                  key={a._id}
                  className="border-t border-rim cursor-pointer"
                  // row tint comes from SEV_BG by severity at runtime
                  // (info/warning/error/critical — 4 distinct rgba).
                  style={{ background: SEV_BG[a.severity || ''] || '' }}
                  onClick={() => setDetail(a)}
                >
                  <td className={`${TD_CLS} text-dim text-[0.76rem] whitespace-nowrap`}>{fmtDateTime(a.created_at)}</td>
                  <td className={TD_CLS}>
                    <span className="bg-[rgba(79,70,229,0.08)] text-acc py-[0.1rem] px-[0.4rem] rounded-sm text-[0.7rem] font-semibold">{a.actor_type}</span>{' '}
                    {a.actor_name || a.actor_id || ''}
                  </td>
                  <td className={`${TD_CLS} font-medium`}>{a.action}</td>
                  <td className={`${TD_CLS} max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap`} title={a.description || ''}>{a.description || ''}</td>
                  <td className={TD_CLS}>
                    <span
                      className="font-semibold text-[0.76rem]"
                      // colour from SEV_COLORS by severity at runtime.
                      style={{ color: SEV_COLORS[a.severity || ''] || 'var(--gb-slate-500)' }}
                    >{sevIcon(a.severity)} {a.severity}</span>
                  </td>
                  <td className={`${TD_CLS} text-[0.78rem]`} onClick={(e) => e.stopPropagation()}>
                    {a.restaurant_id ? (
                      <a href="#" onClick={(e) => { e.preventDefault(); onOpenDrilldown(a.restaurant_id || ''); }} className="text-acc font-medium no-underline">
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

interface WebhooksTabProps { autoRefresh: boolean }

function WebhooksTab({ autoRefresh }: WebhooksTabProps): ReactNode {
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [rows, setRows] = useState<WebhookRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<unknown | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = (await getWebhooksLive({ page, limit: 50 })) as WebhooksResponse | null;
      setRows(r?.webhooks || []);
      setTotalPages(r?.pages || 1);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setErr(er?.response?.data?.error || er?.message || 'Failed to load webhooks');
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

  const openDetail = async (id: string) => {
    setDetail({ id });
    setDetailLoading(true);
    setDetailErr(null);
    try {
      const r = await getWebhookDetail(id);
      setDetail(r);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setDetailErr(er?.response?.data?.error || er?.message || 'Failed to load webhook');
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <>
      {err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.82rem]">
            <thead>
              <tr className="bg-ink text-left text-dim text-[0.74rem]">
                <th className={TH_CLS}>Time</th>
                <th className={TH_CLS}>Type</th>
                <th className={TH_CLS}>Phone ID</th>
                <th className={TH_CLS}>Status</th>
                <th className={TH_CLS}>View</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className={EMPTY_CLS}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={5} className={EMPTY_CLS}>No webhook logs.</td></tr>
              ) : rows.map((w) => {
                const stCls = w.status === 'processed'
                  ? 'text-[#047857]'
                  : w.status === 'failed'
                    ? 'text-red-600'
                    : 'text-dim';
                return (
                  <tr key={w._id} className="border-t border-rim">
                    <td className={`${TD_CLS} text-dim text-[0.76rem] whitespace-nowrap`}>{fmtDateTime(w.received_at || w.created_at)}</td>
                    <td className={TD_CLS}>{w.type || 'message'}</td>
                    <td className={TD_CLS}>{w.phone_number_id || '—'}</td>
                    <td className={`${TD_CLS} font-semibold text-[0.78rem] ${stCls}`}>{w.status || 'received'}</td>
                    <td className={TD_CLS}><button type="button" className="btn-g btn-sm" onClick={() => openDetail(w._id)}>View</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} totalPages={totalPages} onChange={setPage} loading={loading} />

      {detail !== null && (
        <div
          onClick={() => { setDetail(null); setDetailErr(null); }}
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
        >
          <div onClick={(e) => e.stopPropagation()} className="bg-neutral-0 rounded-[10px] w-full max-w-[720px] max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between py-[0.8rem] px-4 border-b border-rim">
              <h3 className="m-0 text-[0.95rem]">Webhook Detail</h3>
              <button type="button" className="btn-g btn-sm" onClick={() => { setDetail(null); setDetailErr(null); }}>✕</button>
            </div>
            <div className="overflow-y-auto p-4 bg-ink flex-1">
              {detailLoading ? (
                <div className="text-dim">Loading…</div>
              ) : detailErr ? (
                <SectionError message={detailErr} />
              ) : (
                <pre className="m-0 text-[0.78rem] whitespace-pre-wrap break-all mono">{JSON.stringify(detail, null, 2)}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface ErrorsTabProps {
  autoRefresh: boolean;
  restMap: Record<string, string>;
  onStatsChange: () => void;
  onOpenDrilldown: (rid: string) => void;
}

function ErrorsTab({ autoRefresh, restMap, onStatsChange, onOpenDrilldown }: ErrorsTabProps): ReactNode {
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [hideResolved, setHideResolved] = useState<boolean>(true);
  const [busy, setBusy] = useState<string | null>(null);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = (await getActivityErrors({ page, limit: 50 })) as ErrorsResponse | null;
      setRows(r?.errors || []);
      setTotalPages(Math.ceil((r?.total || 0) / (r?.limit || 50)) || 1);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setErr(er?.response?.data?.error || er?.message || 'Failed to load errors');
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

  const markResolved = async (id: string) => {
    setBusy(id);
    try {
      await resolveActivity(id);
      showToast('Marked resolved', 'success');
      load();
      onStatsChange?.();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to resolve', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex justify-between items-center py-[0.6rem] px-4 border-b border-rim">
        <label className="text-[0.8rem] text-dim flex items-center gap-[0.3rem]">
          <input type="checkbox" checked={hideResolved} onChange={(e) => setHideResolved(e.target.checked)} />
          Hide resolved
        </label>
        <span className="text-[0.8rem] text-dim">Unresolved: <strong>{unresolvedCount}</strong></span>
      </div>

      {err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.82rem]">
            <thead>
              <tr className="bg-ink text-left text-dim text-[0.74rem]">
                <th className={TH_CLS}>Time</th>
                <th className={TH_CLS}>Action</th>
                <th className={TH_CLS}>Description</th>
                <th className={TH_CLS}>Actor</th>
                <th className={TH_CLS}>Restaurant</th>
                <th className={TH_CLS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className={EMPTY_CLS}>Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className={EMPTY_CLS}>No errors found.</td></tr>
              ) : filtered.map((e) => (
                <tr key={e._id} className={`border-t border-rim ${e.resolved_at ? 'bg-[rgba(22,163,74,0.04)]' : 'bg-[rgba(239,68,68,0.05)]'}`}>
                  <td className={`${TD_CLS} text-dim text-[0.76rem] whitespace-nowrap`}>{fmtDateTime(e.created_at)}</td>
                  <td className={`${TD_CLS} font-medium`}>{sevIcon(e.severity)} {e.action}</td>
                  <td className={`${TD_CLS} max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap`} title={e.description || ''}>{e.description || ''}</td>
                  <td className={TD_CLS}>{e.actor_name || e.actor_type || '—'}</td>
                  <td className={`${TD_CLS} text-[0.78rem]`}>
                    {e.restaurant_id ? (
                      <a href="#" onClick={(ev) => { ev.preventDefault(); onOpenDrilldown(e.restaurant_id || ''); }} className="text-acc no-underline">
                        {restMap[e.restaurant_id] || e.restaurant_id}
                      </a>
                    ) : '—'}
                  </td>
                  <td className={TD_CLS}>
                    {e.resolved_at ? (
                      <span className="text-[#047857] text-[0.76rem] font-semibold">✅ Resolved</span>
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

interface DrilldownTabProps {
  initialRid: string;
  restaurants: RestaurantLite[];
  restMap: Record<string, string>;
}

interface DrilldownResponse {
  total?: number;
  activities?: ActivityRow[];
  pages?: number;
}

function DrilldownTab({ initialRid, restaurants, restMap }: DrilldownTabProps): ReactNode {
  const [rid, setRid] = useState<string>(initialRid || '');
  const [category, setCategory] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [timeline, setTimeline] = useState<ActivityRow[]>([]);
  const [summary, setSummary] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<ActivityRow | null>(null);

  const load = useCallback(async () => {
    if (!rid) { setTimeline([]); setSummary(0); return; }
    setLoading(true);
    const params: Record<string, string | number> = { page, limit: 50 };
    if (category) params.category = category;
    try {
      const [sumRes, tlRes] = await Promise.all([
        getActivityForRestaurant(rid, { limit: 1 }) as Promise<DrilldownResponse | null>,
        getActivityForRestaurant(rid, params) as Promise<DrilldownResponse | null>,
      ]);
      setSummary(sumRes?.total || 0);
      setTimeline(tlRes?.activities || []);
      setTotalPages(tlRes?.pages || 1);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setTimeline([]);
      setErr(er?.response?.data?.error || er?.message || 'Failed to load timeline');
    } finally {
      setLoading(false);
    }
  }, [rid, category, page]);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo<Record<string, ActivityRow[]>>(() => {
    const groups: Record<string, ActivityRow[]> = {};
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    timeline.forEach((a) => {
      const d = new Date(a.created_at || '').toDateString();
      const label = d === today ? 'Today' : d === yesterday ? 'Yesterday' :
        new Date(a.created_at || '').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      if (!groups[label]) groups[label] = [];
      groups[label].push(a);
    });
    return groups;
  }, [timeline]);

  return (
    <>
      <div className="flex flex-wrap gap-2 py-3 px-4 border-b border-rim">
        <select value={rid} onChange={(e) => { setRid(e.target.value); setPage(1); }} className={`${INPUT_CLS} min-w-[220px]`}>
          <option value="">Select a restaurant…</option>
          {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} className={INPUT_CLS}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {!rid ? (
        <div className="p-8 text-center text-dim">Select a restaurant to view its activity timeline.</div>
      ) : err ? (
        <div className="cb"><SectionError message={err} onRetry={load} /></div>
      ) : (
        <div className="p-4">
          <div className="bg-neutral-0 border border-rim rounded-lg p-[0.8rem] mb-4">
            <span className="text-[1.05rem] font-bold">{restMap[rid] || rid}</span>
            <span className="text-dim text-[0.82rem] ml-[0.8rem]">{summary} total events</span>
          </div>
          {loading ? (
            <div className="text-dim text-center p-8">Loading…</div>
          ) : timeline.length === 0 ? (
            <div className="text-center p-8 text-dim">No activity found for this restaurant.</div>
          ) : Object.entries(grouped).map(([label, items]) => (
            <div key={label} className="mb-[1.2rem]">
              <div className="text-[0.78rem] font-bold text-dim uppercase tracking-[0.04em] mb-2 pb-[0.3rem] border-b border-rim">{label}</div>
              {items.map((a) => (
                <div
                  key={a._id}
                  onClick={() => setDetail(a)}
                  className="flex gap-[0.6rem] items-start py-[0.4rem] border-b border-[rgba(226,232,240,0.5)] cursor-pointer"
                >
                  <span className="text-[0.76rem] text-dim whitespace-nowrap min-w-[70px]">
                    {a.created_at ? new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
                  </span>
                  <span className="text-[0.82rem]">{sevIcon(a.severity)}</span>
                  <span className="bg-[rgba(79,70,229,0.06)] text-acc py-[0.1rem] px-[0.35rem] rounded-sm text-[0.68rem] font-semibold">{a.category || 'general'}</span>
                  <span
                    className="text-[0.82rem] font-medium"
                    // colour from SEV_COLORS by severity at runtime.
                    style={{ color: SEV_COLORS[a.severity || ''] || 'var(--gb-slate-500)' }}
                  >{a.action}</span>
                  <span className="text-[0.8rem] text-dim flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{a.description || ''}</span>
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

interface PagerProps {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  loading: boolean;
}

function Pager({ page, totalPages, onChange, loading }: PagerProps): ReactNode {
  return (
    <div className="flex justify-between items-center py-[0.6rem] px-4 border-t border-rim">
      <button type="button" className="btn-g btn-sm" onClick={() => onChange(Math.max(1, page - 1))} disabled={page <= 1 || loading}>← Prev</button>
      <span className="text-[0.8rem] text-dim">Page {page} of {totalPages}</span>
      <button type="button" className="btn-g btn-sm" onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages || loading}>Next →</button>
    </div>
  );
}

interface ActivityDetailModalProps {
  activity: ActivityRow;
  restMap: Record<string, string>;
  onClose: () => void;
}

function ActivityDetailModal({ activity: a, restMap, onClose }: ActivityDetailModalProps): ReactNode {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="bg-neutral-0 rounded-[10px] w-full max-w-[640px] max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between py-[0.8rem] px-4 border-b border-rim">
          <h3 className="m-0 text-[0.95rem]">Activity Detail</h3>
          <button type="button" className="btn-g btn-sm" onClick={onClose}>✕</button>
        </div>
        <div className="overflow-y-auto p-4 flex-1">
          <div className="grid grid-cols-[auto_1fr] gap-y-[0.3rem] gap-x-[0.8rem] mb-[0.8rem] text-[0.82rem]">
            <span className="text-dim">Time:</span><span>{a.created_at ? new Date(a.created_at).toLocaleString() : ''}</span>
            <span className="text-dim">Action:</span><span className="font-semibold">{a.action}</span>
            <span className="text-dim">Category:</span><span>{a.category || ''}</span>
            <span className="text-dim">Severity:</span>
            <span
              className="font-semibold"
              // colour from SEV_COLORS by severity at runtime.
              style={{ color: SEV_COLORS[a.severity || ''] || 'inherit' }}
            >{a.severity}</span>
            <span className="text-dim">Actor:</span><span>{a.actor_type} — {a.actor_name || a.actor_id || 'N/A'}</span>
            <span className="text-dim">Restaurant:</span><span>{a.restaurant_id ? (restMap[a.restaurant_id] || a.restaurant_id) : 'N/A'}</span>
            {a.resource_type && <>
              <span className="text-dim">Resource:</span><span>{a.resource_type}{a.resource_id ? ' #' + a.resource_id : ''}</span>
            </>}
          </div>
          <div className="mb-[0.6rem] text-[0.85rem]">
            <strong>Description:</strong><br />{a.description || 'No description'}
          </div>
          {a.metadata !== null && a.metadata !== undefined && (
            <div>
              <strong className="text-[0.85rem]">Metadata:</strong>
              <pre className="bg-ink p-3 rounded-md text-[0.78rem] overflow-x-auto whitespace-pre-wrap break-all mt-[0.3rem] mono">
                {JSON.stringify(a.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
