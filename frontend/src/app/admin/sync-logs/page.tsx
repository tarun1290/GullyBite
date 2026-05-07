'use client';

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

const TH_CLS = 'py-2 px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.35rem] px-[0.55rem] text-[0.78rem]';

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
      <div className="card mb-4">
        <div className="ch justify-between flex-wrap gap-[0.6rem]">
          <h3 className="m-0">⚠ Active Alerts
            <span className="text-dim text-[0.78rem] font-medium ml-[0.6rem]">
              {alertsLoading ? '…' : alerts.length ? `${alerts.length} active` : 'all clear'}
            </span>
          </h3>
          <button type="button" className="btn-g btn-sm" onClick={loadAlerts} disabled={alertsLoading}>Refresh</button>
        </div>
        {alertsErr ? (
          <div className="cb"><SectionError message={alertsErr} onRetry={loadAlerts} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink text-left text-dim text-[0.74rem]">
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Message</th>
                  <th className={TH_CLS}>Failure Rate</th>
                  <th className={TH_CLS}>Time</th>
                  <th className={TH_CLS}>Action</th>
                </tr>
              </thead>
              <tbody>
                {alertsLoading ? (
                  <tr><td colSpan={5} className={EMPTY_CLS}>Loading alerts…</td></tr>
                ) : alerts.length === 0 ? (
                  <tr><td colSpan={5} className={EMPTY_CLS}>No active alerts</td></tr>
                ) : alerts.map((a) => (
                  <tr key={a.id} className="bg-[#fef2f2] border-t border-rim">
                    <td className={`${TD_CLS} text-red-900 font-semibold`}>{a.restaurant_name || a.restaurant_id || '—'}</td>
                    <td className={`${TD_CLS} text-[#7f1d1d]`}>{a.message}</td>
                    <td className={`${TD_CLS} text-red-600 font-semibold`}>{a.failure_rate != null ? Math.round(a.failure_rate * 100) + '%' : '—'}</td>
                    <td className={`${TD_CLS} text-dim text-[0.75rem] whitespace-nowrap`}>{fmtTime(a.timestamp)}</td>
                    <td className={TD_CLS}>
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
        <div className="ch justify-between flex-wrap gap-[0.6rem]">
          <h3 className="m-0">Catalog Sync Audit <span className="text-dim text-[0.78rem] font-medium">({rows.length} entries)</span></h3>
          <div className="flex gap-[0.4rem]">
            <button type="button" className="btn-g btn-sm" onClick={resetFilters}>Reset</button>
            <button type="button" className="btn-p btn-sm" onClick={loadLogs} disabled={loading}>Refresh</button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 py-3 px-4 border-b border-rim">
          <select value={rid} onChange={(e) => setRid(e.target.value)} className={`${INPUT_CLS} min-w-[180px]`}>
            <option value="">All restaurants</option>
            {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={INPUT_CLS}>
            <option value="">All statuses</option>
            <option value="synced">Synced</option>
            <option value="skipped">Skipped</option>
          </select>
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT_CLS}>
            {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={INPUT_CLS} />
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={INPUT_CLS} />
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={loadLogs} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink text-left text-dim text-[0.74rem]">
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Product</th>
                  <th className={TH_CLS}>Branch</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Reason</th>
                  <th className={TH_CLS}>Time</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} className={EMPTY_CLS}>No sync logs match the filters.</td></tr>
                ) : rows.map((r, i) => {
                  const isSynced = r.status === 'synced';
                  return (
                    <tr key={r.id || i} className="border-t border-rim">
                      <td className={TD_CLS}>{r.restaurant_name || r.restaurant_id || '—'}</td>
                      <td className={TD_CLS}>{r.product_name || r.product_id || '—'}</td>
                      <td className={TD_CLS}>{r.branch_name || r.branch_id || '—'}</td>
                      <td className={TD_CLS}>
                        <span className={`inline-block py-[0.1rem] px-2 rounded-full text-[0.72rem] font-semibold ${isSynced ? 'bg-[#d1fae5] text-[#047857]' : 'bg-red-100 text-red-600'}`}>{r.status || '—'}</span>
                      </td>
                      <td className={`${TD_CLS} text-[0.78rem] text-dim`}>
                        {r.reason || ''}
                        {r.suggestion && <div className="mt-[0.2rem] text-[0.7rem] text-indigo-600">💡 {r.suggestion}</div>}
                      </td>
                      <td className={`${TD_CLS} text-[0.75rem] text-dim whitespace-nowrap`}>{fmtTime(r.timestamp)}</td>
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
