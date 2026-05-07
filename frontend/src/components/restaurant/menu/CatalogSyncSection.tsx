'use client';

import { useEffect, useState } from 'react';
import { useToast } from '../../Toast';
import {
  syncCatalog,
  reverseSyncCatalog,
  getCatalogSyncStatus,
  getMenuUnassigned,
  quickSyncBranchCatalog,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

interface SyncStatus {
  lastSyncToMeta?: string | null;
  lastSyncFromMeta?: string | null;
}

interface SyncResult {
  totalSynced?: number;
  totalFailed?: number;
}

interface ReverseSyncResult {
  new_items_added?: number;
  existing_items_updated?: number;
}

interface QuickSyncResult {
  success?: boolean;
  updated?: number;
  errors?: string[];
}

interface CatalogSyncSectionProps {
  branches: Branch[];
  selectedBranchId: string;
}

function timeAgoShort(ts?: string | null): string | null {
  if (!ts) return null;
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

type PendingAction = 'push' | 'pull' | null;

export default function CatalogSyncSection({ branches, selectedBranchId }: CatalogSyncSectionProps) {
  const { showToast } = useToast();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [pushing, setPushing] = useState<boolean>(false);
  const [pulling, setPulling] = useState<boolean>(false);
  const [unassignedCount, setUnassignedCount] = useState<number>(0);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const refreshStatus = async () => {
    try {
      const s = (await getCatalogSyncStatus()) as SyncStatus | null;
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
      const r = (await syncCatalog()) as SyncResult;
      const synced = r.totalSynced || 0;
      const failed = r.totalFailed || 0;
      if (failed === 0) showToast(`✅ ${synced} items synced to catalog`, 'success');
      else showToast(`⚠️ ${synced} synced, ${failed} failed`, 'error');
      refreshStatus();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Sync failed', 'error');
    } finally {
      setPushing(false);
    }
  };

  const doPull = async () => {
    setPulling(true);
    setPendingAction(null);
    try {
      const r = (await reverseSyncCatalog()) as ReverseSyncResult;
      showToast(`⬇ ${r.new_items_added || 0} new, ${r.existing_items_updated || 0} updated from catalog`, 'success');
      refreshStatus();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Pull failed', 'error');
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

  const doQuickSync = async (branchId: string) => {
    try {
      const r = (await quickSyncBranchCatalog(branchId)) as QuickSyncResult;
      if (r.success) showToast(`✅ ${r.updated} items live on WhatsApp!`, 'success');
      else showToast(r.errors?.[0] || 'Sync failed', 'error');
      refreshStatus();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Sync failed', 'error');
    }
  };

  const pushedAgo = timeAgoShort(status?.lastSyncToMeta);
  const pulledAgo = timeAgoShort(status?.lastSyncFromMeta);

  return (
    <div>
      <div className="card mb-4">
        <div className="ch"><h3>🔄 Catalog Sync</h3></div>
        <div className="cb">
          <p className="text-[0.84rem] text-dim mb-[0.8rem] leading-[1.55]">
            Push your GullyBite menu to your WhatsApp (Meta) catalog, or pull changes Meta has back
            into GullyBite. You can push/pull the whole restaurant here — per-branch sync is
            available from the editor above.
          </p>

          <div className="flex gap-2 flex-wrap mb-[0.8rem]">
            <button type="button" className="btn-p" onClick={tryPush} disabled={pushing || pulling}>
              {pushing ? '⬆ Syncing…' : '⬆ Sync to Meta'}
            </button>
            <button type="button" className="btn-g" onClick={tryPull} disabled={pushing || pulling}>
              {pulling ? '⬇ Pulling…' : '⬇ Sync from Meta'}
            </button>
          </div>

          {(pushedAgo || pulledAgo) && (
            <p className="text-[0.78rem] text-dim">
              Last sync:
              {pushedAgo && <> ⬆ {pushedAgo}</>}
              {pushedAgo && pulledAgo && ' · '}
              {pulledAgo && <>⬇ {pulledAgo}</>}
            </p>
          )}

          {pendingAction && (
            <div className="mt-[0.8rem] bg-[#fffbeb] border border-[#fde68a] rounded-lg p-[0.85rem]">
              <div className="text-[0.86rem] font-semibold text-[#92400e] mb-[0.4rem]">
                ⚠️ {unassignedCount} unassigned product{unassignedCount === 1 ? '' : 's'}
              </div>
              <p className="text-[0.78rem] text-[#78350f] mb-[0.6rem] leading-[1.45]">
                Unassigned products won&apos;t be pushed to Meta. Assign them to a branch first, or
                proceed regardless — the backend will skip them with a structured reason.
              </p>
              <div className="flex gap-[0.4rem] justify-end">
                <button type="button" className="btn-g btn-sm" onClick={() => setPendingAction(null)}>Cancel</button>
                <button
                  type="button"
                  className="btn-p btn-sm"
                  onClick={confirmPending}
                >
                  Proceed regardless
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
          <p className="text-[0.82rem] text-dim mb-[0.6rem]">
            Push a single branch&apos;s menu to Meta without touching others. The badge next to each
            branch reflects whether the branch has any items assigned (✓ green) or is empty (✗ red);
            sync against an empty branch is a no-op — add items first.
          </p>
          {!branches.length ? (
            <p className="text-dim text-[0.84rem]">No branches yet.</p>
          ) : (
            <div className="flex flex-col gap-[0.35rem]">
              {branches
                .filter((b) => b.is_active !== false)
                .map((b) => {
                  // item_count is server-attached by GET /api/restaurant/branches
                  // and counts menu_items where the branch appears in either
                  // the legacy scalar `branch_id` or the newer `branch_ids`
                  // array. Coerced through `?? 0` so an undefined field
                  // (e.g. served from a stale cached payload, or from a
                  // future endpoint that doesn't compute the count) renders
                  // as the empty state rather than throwing.
                  const hasItems = (b.item_count ?? 0) > 0;
                  return (
                    <div
                      key={b.id}
                      className="flex items-center gap-[0.6rem] py-2 px-[0.7rem] bg-ink2 rounded-lg"
                    >
                      <span className={`flex-1 text-[0.86rem] ${selectedBranchId === b.id ? 'font-semibold' : 'font-normal'}`}>{b.name}</span>
                      {hasItems ? (
                        <span className="badge bg text-[0.68rem]">✓ Catalog</span>
                      ) : (
                        <span className="text-[0.68rem] py-[0.15rem] px-[0.45rem] rounded-[4px] bg-[rgba(220,38,38,0.10)] border border-[rgba(220,38,38,0.45)] text-[#dc2626] font-semibold whitespace-nowrap">
                          ✗ No Items
                        </span>
                      )}
                      <button type="button" className="btn-g btn-sm" onClick={() => doQuickSync(b.id)}>🔄 Sync</button>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
