'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getDirectoryListings,
  getDirectoryStats,
  syncAllDirectory,
  toggleDirectoryListing,
} from '../../../api/admin';

interface DirectoryStats {
  total?: number;
  active?: number;
  total_views?: number | string;
  total_orders?: number | string;
}

interface DirectoryListing {
  _id: string;
  brand_name?: string;
  business_name?: string;
  restaurant_id?: string;
  city?: string;
  restaurant_type?: string;
  view_count?: number;
  order_count?: number;
  is_active?: boolean;
}

interface DirectoryListingsResponse { listings?: DirectoryListing[] }

const TYPE_LABEL: Record<string, string> = { veg: 'Veg', non_veg: 'Non-Veg', both: 'Both' };
const TYPE_COLOR: Record<string, string> = { veg: 'var(--gb-wa-500)', non_veg: 'var(--gb-red-500)', both: '#3b82f6' };

function fmtNum(n: number | string | null | undefined): string {
  const v = Number(n || 0);
  try { return v.toLocaleString('en-IN'); } catch { return String(v); }
}

const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.6rem] px-[0.7rem] align-top';
const SUB_CLS = 'text-[0.72rem] text-dim';
const EMPTY_CLS = 'p-6 text-center text-dim';

export default function AdminDirectoryPage() {
  const { showToast } = useToast();
  const [stats, setStats] = useState<DirectoryStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [listings, setListings] = useState<DirectoryListing[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState<boolean>(false);
  const [confirmSync, setConfirmSync] = useState<boolean>(false);

  const loadStats = useCallback(async () => {
    try {
      const s = (await getDirectoryStats()) as DirectoryStats | null;
      setStats(s);
      setStatsErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setStatsErr(er?.response?.data?.error || er?.message || 'Stats failed');
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const d = (await getDirectoryListings({ limit: 100 })) as DirectoryListingsResponse | null;
      setListings(Array.isArray(d?.listings) ? d.listings : []);
      setListErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setListErr(er?.response?.data?.error || er?.message || 'Listings failed');
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadStats(), loadList()]);
    setLoading(false);
  }, [loadStats, loadList]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const doToggle = async (row: DirectoryListing, nextActive: boolean) => {
    setRowBusy(row._id);
    try {
      await toggleDirectoryListing(row._id, nextActive);
      showToast(nextActive ? 'Listing activated' : 'Listing deactivated', 'success');
      await loadList();
      await loadStats();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Toggle failed', 'error');
    } finally {
      setRowBusy(null);
    }
  };

  const doSyncAll = async () => {
    setSyncBusy(true);
    try {
      await syncAllDirectory();
      showToast('Directory sync started — refresh in a few seconds', 'success');
      setConfirmSync(false);
      setTimeout(() => { loadAll(); }, 3000);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Sync failed', 'error');
    } finally {
      setSyncBusy(false);
    }
  };

  return (
    <div id="pg-directory">
      {statsErr ? (
        <div className="mb-4">
          <SectionError message={statsErr} onRetry={loadStats} />
        </div>
      ) : (
        <div className="stats">
          <StatCard label="Total Listings"       value={loading ? '—' : (stats?.total ?? 0)} delta="All" />
          <StatCard label="Active"               value={loading ? '—' : (stats?.active ?? 0)} delta="Visible in directory" />
          <StatCard label="Total Views"          value={loading ? '—' : fmtNum(stats?.total_views)} delta="Cumulative" />
          <StatCard label="Orders via Directory" value={loading ? '—' : fmtNum(stats?.total_orders)} delta="Cumulative" />
        </div>
      )}

      <div className="card mb-4">
        <div className="ch gap-[0.6rem] flex-wrap">
          <h3>Sync</h3>
          <span className="text-dim text-[0.78rem] mr-auto">
            Re-syncs all approved restaurants into the directory.
          </span>
          {confirmSync ? (
            <>
              <span className="text-[0.78rem] text-dim">Are you sure?</span>
              <button type="button" className="btn-p btn-sm" onClick={doSyncAll} disabled={syncBusy}>
                {syncBusy ? 'Syncing…' : 'Yes, sync'}
              </button>
              <button type="button" className="btn-g btn-sm" onClick={() => setConfirmSync(false)} disabled={syncBusy}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="btn-p btn-sm" onClick={() => setConfirmSync(true)} disabled={syncBusy}>
              Sync All Listings
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="ch justify-between">
          <h3>Directory Listings</h3>
          <button type="button" className="btn-g btn-sm" onClick={loadList} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadList} /></div>
        ) : (
          <div className="cb overflow-x-auto p-0">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>City</th>
                  <th className={TH_CLS}>Type</th>
                  <th className={TH_CLS}>Views</th>
                  <th className={TH_CLS}>Orders</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>Loading…</td></tr>
                ) : listings.length === 0 ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>
                    No directory listings yet. Approve restaurants to auto-list them.
                  </td></tr>
                ) : (
                  listings.map((l) => {
                    const type = l.restaurant_type || 'both';
                    const busy = rowBusy === l._id;
                    return (
                      <tr key={l._id} className="border-b border-rim">
                        <td className={TD_CLS}>
                          <strong>{l.brand_name || l.business_name}</strong>
                          <div className={SUB_CLS}>{String(l.restaurant_id || '').slice(0, 8)}</div>
                        </td>
                        <td className={TD_CLS}>{l.city || '—'}</td>
                        <td className={TD_CLS}>
                          <span
                            className="font-semibold text-[0.72rem]"
                            // colour comes from TYPE_COLOR by restaurant_type
                            // at runtime (veg/non_veg/both — 3 distinct).
                            style={{ color: TYPE_COLOR[type] }}
                          >
                            {TYPE_LABEL[type]}
                          </span>
                        </td>
                        <td className={TD_CLS}>{l.view_count || 0}</td>
                        <td className={TD_CLS}>{l.order_count || 0}</td>
                        <td className={TD_CLS}>
                          {l.is_active ? (
                            <span className="text-wa-500 font-semibold text-[0.72rem]">Active</span>
                          ) : (
                            <span className="text-dim font-semibold text-[0.72rem]">Inactive</span>
                          )}
                        </td>
                        <td className={TD_CLS}>
                          <label className="tsl">
                            <input
                              type="checkbox"
                              checked={!!l.is_active}
                              disabled={busy}
                              onChange={(e) => doToggle(l, e.target.checked)}
                            />
                            <span className="tsl-track" />
                          </label>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
