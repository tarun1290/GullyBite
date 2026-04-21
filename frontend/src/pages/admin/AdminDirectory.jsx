import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import StatCard from '../../components/StatCard.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import {
  getDirectoryListings,
  getDirectoryStats,
  syncAllDirectory,
  toggleDirectoryListing,
} from '../../api/admin.js';

// Mirrors admin.html loadDirectory (2549-2592): stat strip + Sync-all
// + 7-col listings table with per-row toggle.

const TYPE_LABEL = { veg: 'Veg', non_veg: 'Non-Veg', both: 'Both' };
const TYPE_COLOR = { veg: 'var(--gb-wa-500)', non_veg: 'var(--gb-red-500)', both: '#3b82f6' };

function fmtNum(n) {
  const v = Number(n || 0);
  try { return v.toLocaleString('en-IN'); } catch { return String(v); }
}

export default function AdminDirectory() {
  const { showToast } = useToast();
  const [stats, setStats] = useState(null);
  const [statsErr, setStatsErr] = useState(null);
  const [listings, setListings] = useState([]);
  const [listErr, setListErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rowBusy, setRowBusy] = useState(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [confirmSync, setConfirmSync] = useState(false);

  const loadStats = useCallback(async () => {
    try {
      const s = await getDirectoryStats();
      setStats(s);
      setStatsErr(null);
    } catch (e) {
      setStatsErr(e?.response?.data?.error || e?.message || 'Stats failed');
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const d = await getDirectoryListings({ limit: 100 });
      setListings(Array.isArray(d?.listings) ? d.listings : []);
      setListErr(null);
    } catch (e) {
      setListErr(e?.response?.data?.error || e?.message || 'Listings failed');
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadStats(), loadList()]);
    setLoading(false);
  }, [loadStats, loadList]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const doToggle = async (row, nextActive) => {
    setRowBusy(row._id);
    try {
      await toggleDirectoryListing(row._id, nextActive);
      showToast(nextActive ? 'Listing activated' : 'Listing deactivated', 'success');
      await loadList();
      await loadStats();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Toggle failed', 'error');
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
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Sync failed', 'error');
    } finally {
      setSyncBusy(false);
    }
  };

  return (
    <div id="pg-directory">
      {statsErr ? (
        <div style={{ marginBottom: '1rem' }}>
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

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch" style={{ gap: '.6rem', flexWrap: 'wrap' }}>
          <h3>Sync</h3>
          <span style={{ color: 'var(--dim)', fontSize: '.78rem', marginRight: 'auto' }}>
            Re-syncs all approved restaurants into the directory.
          </span>
          {confirmSync ? (
            <>
              <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Are you sure?</span>
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
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>Directory Listings</h3>
          <button type="button" className="btn-g btn-sm" onClick={loadList} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadList} /></div>
        ) : (
          <div className="cb" style={{ overflowX: 'auto', padding: 0 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', borderBottom: '1px solid var(--rim)' }}>
                  <th style={th}>Restaurant</th>
                  <th style={th}>City</th>
                  <th style={th}>Type</th>
                  <th style={th}>Views</th>
                  <th style={th}>Orders</th>
                  <th style={th}>Status</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} style={emptyCell}>Loading…</td></tr>
                ) : listings.length === 0 ? (
                  <tr><td colSpan={7} style={emptyCell}>
                    No directory listings yet. Approve restaurants to auto-list them.
                  </td></tr>
                ) : (
                  listings.map((l) => {
                    const type = l.restaurant_type || 'both';
                    const busy = rowBusy === l._id;
                    return (
                      <tr key={l._id} style={{ borderBottom: '1px solid var(--rim)' }}>
                        <td style={td}>
                          <strong>{l.brand_name || l.business_name}</strong>
                          <div style={sub}>{String(l.restaurant_id || '').slice(0, 8)}</div>
                        </td>
                        <td style={td}>{l.city || '—'}</td>
                        <td style={td}>
                          <span style={{ color: TYPE_COLOR[type], fontWeight: 600, fontSize: '.72rem' }}>
                            {TYPE_LABEL[type]}
                          </span>
                        </td>
                        <td style={td}>{l.view_count || 0}</td>
                        <td style={td}>{l.order_count || 0}</td>
                        <td style={td}>
                          {l.is_active ? (
                            <span style={{ color: 'var(--gb-wa-500)', fontWeight: 600, fontSize: '.72rem' }}>Active</span>
                          ) : (
                            <span style={{ color: 'var(--dim)', fontWeight: 600, fontSize: '.72rem' }}>Inactive</span>
                          )}
                        </td>
                        <td style={td}>
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

const th = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td = { padding: '.6rem .7rem', verticalAlign: 'top' };
const sub = { fontSize: '.72rem', color: 'var(--dim)' };
const emptyCell = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
