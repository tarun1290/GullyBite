'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getSyncLogs,
  getMetaAlerts,
  resolveMetaAlert,
  getAdminRestaurants,
} from '../../../api/admin';
import type { AdminRestaurant } from '../../../types';

interface ReasonOpt { value: string; label: string }

const REASONS: ReadonlyArray<ReasonOpt> = [
  { value: '',                   label: 'Any reason' },
  { value: 'UNASSIGNED_PRODUCT', label: 'Unassigned product' },
  { value: 'META_INCOMPLETE',    label: 'Meta incomplete' },
  { value: 'FSSAI_MISSING',      label: 'FSSAI missing' },
  { value: 'PRICE_MISSING',      label: 'Price missing' },
  { value: 'BRANCH_INACTIVE',    label: 'Branch inactive' },
];

interface RestaurantLite { id: string; name: string }

interface MetaAlert {
  id: string;
  restaurant_name?: string;
  restaurant_id?: string;
  message?: string;
  failure_rate?: number;
  timestamp?: string;
}

interface MetaAlertsResponse { alerts?: MetaAlert[] }

interface SyncLogRow {
  id?: string;
  restaurant_name?: string;
  restaurant_id?: string;
  product_name?: string;
  product_id?: string;
  branch_name?: string;
  branch_id?: string;
  status?: string;
  reason?: string;
  suggestion?: string;
  timestamp?: string;
}

interface SyncLogsResponse {
  logs?: SyncLogRow[];
  items?: SyncLogRow[];
}

interface AdminRestaurantExt extends AdminRestaurant {
  _id?: string;
  business_name?: string;
}

interface RestaurantsListEnvelope {
  items?: AdminRestaurantExt[];
  restaurants?: AdminRestaurantExt[];
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

export default function AdminSyncLogsPage() {
  const { showToast } = useToast();

  const [restaurants, setRestaurants] = useState<RestaurantLite[]>([]);

  const [alerts, setAlerts] = useState<MetaAlert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState<boolean>(true);
  const [alertsErr, setAlertsErr] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const [rows, setRows] = useState<SyncLogRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const [rid, setRid] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  useEffect(() => {
    (async () => {
      try {
        const list = (await getAdminRestaurants()) as AdminRestaurantExt[] | RestaurantsListEnvelope | null;
        const items: AdminRestaurantExt[] = Array.isArray(list)
          ? list
          : (list?.items || list?.restaurants || []);
        setRestaurants(items.map((r) => ({
          id: (r.id || r._id) || '',
          name: r.business_name || r.name || r.id || r._id || '',
        })));
      } catch {
        // non-fatal
      }
    })();
  }, []);

  const loadAlerts = useCallback(async () => {
    setAlertsLoading(true);
    try {
      const d = (await getMetaAlerts({ status: 'active', type: 'META_SYNC_FAILURE', limit: 50 })) as MetaAlertsResponse | null;
      setAlerts(d?.alerts || []);
      setAlertsErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setAlerts([]);
      setAlertsErr(er?.response?.data?.error || er?.message || 'Failed to load alerts');
    } finally {
      setAlertsLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string | number> = { limit: 200 };
    if (rid) params.restaurant_id = rid;
    if (status) params.status = status;
    if (reason) params.reason = reason;
    if (fromDate) params.from = fromDate;
    if (toDate) params.to = toDate;
    try {
      const d = (await getSyncLogs(params)) as SyncLogsResponse | SyncLogRow[] | null;
      const list: SyncLogRow[] = Array.isArray(d)
        ? d
        : (d?.logs || d?.items || []);
      setRows(list);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setErr(er?.response?.data?.error || er?.message || 'Failed to load sync logs');
    } finally {
      setLoading(false);
    }
  }, [rid, status, reason, fromDate, toDate]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);
  useEffect(() => { loadLogs(); }, [loadLogs]);

  const resetFilters = () => {
    setRid(''); setStatus(''); setReason(''); setFromDate(''); setToDate('');
  };

  const resolveAlert = async (id: string) => {
    setResolvingId(id);
    try {
      await resolveMetaAlert(id);
      showToast('Alert resolved', 'success');
      loadAlerts();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to resolve', 'error');
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div id="pg-sync-logs">
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '.6rem' }}>
          <h3 style={{ margin: 0 }}>⚠ Active Alerts
            <span style={{ color: 'var(--dim)', fontSize: '.78rem', fontWeight: 500, marginLeft: '.6rem' }}>
              {alertsLoading ? '…' : alerts.length ? `${alerts.length} active` : 'all clear'}
            </span>
          </h3>
          <button type="button" className="btn-g btn-sm" onClick={loadAlerts} disabled={alertsLoading}>Refresh</button>
        </div>
        {alertsErr ? (
          <div className="cb"><SectionError message={alertsErr} onRetry={loadAlerts} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                  <th style={th}>Restaurant</th>
                  <th style={th}>Message</th>
                  <th style={th}>Failure Rate</th>
                  <th style={th}>Time</th>
                  <th style={th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {alertsLoading ? (
                  <tr><td colSpan={5} style={emptyCell}>Loading alerts…</td></tr>
                ) : alerts.length === 0 ? (
                  <tr><td colSpan={5} style={emptyCell}>No active alerts</td></tr>
                ) : alerts.map((a) => (
                  <tr key={a.id} style={{ background: '#fef2f2', borderTop: '1px solid var(--rim)' }}>
                    <td style={{ ...td, color: 'var(--gb-red-900)', fontWeight: 600 }}>{a.restaurant_name || a.restaurant_id || '—'}</td>
                    <td style={{ ...td, color: '#7f1d1d' }}>{a.message}</td>
                    <td style={{ ...td, color: 'var(--gb-red-600)', fontWeight: 600 }}>{a.failure_rate != null ? Math.round(a.failure_rate * 100) + '%' : '—'}</td>
                    <td style={{ ...td, color: 'var(--dim)', fontSize: '.75rem', whiteSpace: 'nowrap' }}>{fmtTime(a.timestamp)}</td>
                    <td style={td}>
                      <button type="button" className="btn-g btn-sm" onClick={() => resolveAlert(a.id)} disabled={resolvingId === a.id}>
                        {resolvingId === a.id ? 'Resolving…' : 'Resolve'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '.6rem' }}>
          <h3 style={{ margin: 0 }}>Catalog Sync Audit <span style={{ color: 'var(--dim)', fontSize: '.78rem', fontWeight: 500 }}>({rows.length} entries)</span></h3>
          <div style={{ display: 'flex', gap: '.4rem' }}>
            <button type="button" className="btn-g btn-sm" onClick={resetFilters}>Reset</button>
            <button type="button" className="btn-p btn-sm" onClick={loadLogs} disabled={loading}>Refresh</button>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', padding: '.75rem 1rem', borderBottom: '1px solid var(--rim)' }}>
          <select value={rid} onChange={(e) => setRid(e.target.value)} style={{ ...input, minWidth: 180 }}>
            <option value="">All restaurants</option>
            {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={input}>
            <option value="">All statuses</option>
            <option value="synced">Synced</option>
            <option value="skipped">Skipped</option>
          </select>
          <select value={reason} onChange={(e) => setReason(e.target.value)} style={input}>
            {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={input} />
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={input} />
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={loadLogs} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                  <th style={th}>Restaurant</th>
                  <th style={th}>Product</th>
                  <th style={th}>Branch</th>
                  <th style={th}>Status</th>
                  <th style={th}>Reason</th>
                  <th style={th}>Time</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} style={emptyCell}>No sync logs match the filters.</td></tr>
                ) : rows.map((r, i) => {
                  const isSynced = r.status === 'synced';
                  return (
                    <tr key={r.id || i} style={{ borderTop: '1px solid var(--rim)' }}>
                      <td style={td}>{r.restaurant_name || r.restaurant_id || '—'}</td>
                      <td style={td}>{r.product_name || r.product_id || '—'}</td>
                      <td style={td}>{r.branch_name || r.branch_id || '—'}</td>
                      <td style={td}>
                        <span style={{
                          display: 'inline-block', padding: '.1rem .5rem', borderRadius: 99,
                          fontSize: '.72rem', fontWeight: 600,
                          background: isSynced ? '#d1fae5' : 'var(--gb-red-100)',
                          color: isSynced ? '#047857' : 'var(--gb-red-600)',
                        }}>{r.status || '—'}</span>
                      </td>
                      <td style={{ ...td, fontSize: '.78rem', color: 'var(--dim)' }}>
                        {r.reason || ''}
                        {r.suggestion && <div style={{ marginTop: '.2rem', fontSize: '.7rem', color: 'var(--gb-indigo-600)' }}>💡 {r.suggestion}</div>}
                      </td>
                      <td style={{ ...td, fontSize: '.75rem', color: 'var(--dim)', whiteSpace: 'nowrap' }}>{fmtTime(r.timestamp)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
