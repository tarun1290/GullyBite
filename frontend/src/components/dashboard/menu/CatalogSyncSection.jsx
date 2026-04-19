import { useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import {
  syncCatalog,
  reverseSyncCatalog,
  getCatalogSyncStatus,
  getMenuUnassigned,
  quickSyncBranchCatalog,
} from '../../../api/restaurant.js';

// Mirrors #sync-to-btn + #sync-from-btn + #sync-status-line (dashboard.html)
// and doSyncToCatalog + doSyncFromCatalog + updateSyncStatus + _checkUnassignedThen
// (menu.js:1286-1333 + 2576-2597). The legacy sync-warn modal becomes an inline
// confirm panel that fires either push or pull depending on pending intent.

function timeAgoShort(ts) {
  if (!ts) return null;
  const secs = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function CatalogSyncSection({ branches, selectedBranchId }) {
  const { showToast } = useToast();
  const [status, setStatus] = useState(null);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [pendingAction, setPendingAction] = useState(null); // 'push' | 'pull' | null

  const refreshStatus = async () => {
    try {
      const s = await getCatalogSyncStatus();
      setStatus(s || null);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    refreshStatus();
    getMenuUnassigned().then((list) => {
      setUnassignedCount(Array.isArray(list) ? list.length : 0);
    }).catch(() => setUnassignedCount(0));
  }, []);

  const doPush = async () => {
    setPushing(true);
    setPendingAction(null);
    try {
      const r = await syncCatalog();
      const synced = r.totalSynced || 0;
      const failed = r.totalFailed || 0;
      if (failed === 0) showToast(`✅ ${synced} items synced to catalog`, 'success');
      else showToast(`⚠️ ${synced} synced, ${failed} failed`, 'error');
      refreshStatus();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Sync failed', 'error');
    } finally {
      setPushing(false);
    }
  };

  const doPull = async () => {
    setPulling(true);
    setPendingAction(null);
    try {
      const r = await reverseSyncCatalog();
      showToast(`⬇ ${r.new_items_added || 0} new, ${r.existing_items_updated || 0} updated from catalog`, 'success');
      refreshStatus();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Pull failed', 'error');
    } finally {
      setPulling(false);
    }
  };

  const tryPush = () => {
    if (unassignedCount > 0) setPendingAction('push');
    else doPush();
  };
  const tryPull = () => {
    // Pull doesn't need the unassigned guard, but keep consistent UX.
    doPull();
  };

  const confirmPending = () => {
    if (pendingAction === 'push') doPush();
    if (pendingAction === 'pull') doPull();
  };

  const doQuickSync = async (branchId) => {
    try {
      const r = await quickSyncBranchCatalog(branchId);
      if (r.success) showToast(`✅ ${r.updated} items live on WhatsApp!`, 'success');
      else showToast(r.errors?.[0] || 'Sync failed', 'error');
      refreshStatus();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Sync failed', 'error');
    }
  };

  const pushedAgo = timeAgoShort(status?.lastSyncToMeta);
  const pulledAgo = timeAgoShort(status?.lastSyncFromMeta);

  return (
    <div>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch"><h3>🔄 Catalog Sync</h3></div>
        <div className="cb">
          <p style={{ fontSize: '.84rem', color: 'var(--dim)', marginBottom: '.8rem', lineHeight: 1.55 }}>
            Push your GullyBite menu to your WhatsApp (Meta) catalog, or pull changes Meta has back
            into GullyBite. You can push/pull the whole restaurant here — per-branch sync is
            available from the editor above.
          </p>

          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginBottom: '.8rem' }}>
            <button type="button" className="btn-p" onClick={tryPush} disabled={pushing || pulling}>
              {pushing ? '⬆ Syncing…' : '⬆ Sync to Catalog'}
            </button>
            <button type="button" className="btn-g" onClick={tryPull} disabled={pushing || pulling}>
              {pulling ? '⬇ Pulling…' : '⬇ Sync from Catalog'}
            </button>
          </div>

          {(pushedAgo || pulledAgo) && (
            <p style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
              Last sync:
              {pushedAgo && <> ⬆ {pushedAgo}</>}
              {pushedAgo && pulledAgo && ' · '}
              {pulledAgo && <>⬇ {pulledAgo}</>}
            </p>
          )}

          {pendingAction && (
            <div
              style={{
                marginTop: '.8rem', background: '#fffbeb', border: '1px solid #fde68a',
                borderRadius: 8, padding: '.85rem',
              }}
            >
              <div style={{ fontSize: '.86rem', fontWeight: 600, color: '#92400e', marginBottom: '.4rem' }}>
                ⚠️ {unassignedCount} unassigned product{unassignedCount === 1 ? '' : 's'}
              </div>
              <p style={{ fontSize: '.78rem', color: '#78350f', marginBottom: '.6rem', lineHeight: 1.45 }}>
                Unassigned products won't be pushed to Meta. Assign them to a branch first, or
                proceed anyway — the backend will skip them with a structured reason.
              </p>
              <div style={{ display: 'flex', gap: '.4rem', justifyContent: 'flex-end' }}>
                <button type="button" className="btn-g btn-sm" onClick={() => setPendingAction(null)}>Cancel</button>
                <button
                  type="button"
                  className="btn-sm"
                  style={{ background: '#d97706', color: '#fff', border: 'none', borderRadius: 6, padding: '.35rem .8rem', fontSize: '.8rem' }}
                  onClick={confirmPending}
                >
                  Proceed anyway
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Quick per-branch sync shortcuts — handy when picking a branch in editor */}
      <div className="card">
        <div className="ch"><h3>⚡ Per-branch Quick Sync</h3></div>
        <div className="cb">
          <p style={{ fontSize: '.82rem', color: 'var(--dim)', marginBottom: '.6rem' }}>
            Push a single branch's menu to Meta without touching others. Only branches with a live
            catalog are listed.
          </p>
          {!branches.length ? (
            <p style={{ color: 'var(--dim)', fontSize: '.84rem' }}>No branches yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.35rem' }}>
              {branches.filter((b) => b.catalog_id).map((b) => (
                <div
                  key={b.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '.6rem',
                    padding: '.5rem .7rem', background: 'var(--ink2,#f4f4f5)', borderRadius: 8,
                  }}
                >
                  <span style={{ flex: 1, fontSize: '.86rem', fontWeight: selectedBranchId === b.id ? 600 : 400 }}>{b.name}</span>
                  <span className="badge bg" style={{ fontSize: '.68rem' }}>✅ Catalog</span>
                  <button type="button" className="btn-g btn-sm" onClick={() => doQuickSync(b.id)}>🔄 Sync</button>
                </div>
              ))}
              {!branches.some((b) => b.catalog_id) && (
                <p style={{ color: 'var(--dim)', fontSize: '.82rem' }}>
                  None of your branches have a catalog yet. Create one from the Branches tab.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
