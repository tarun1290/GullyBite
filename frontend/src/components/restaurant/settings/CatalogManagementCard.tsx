'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useToast } from '../../Toast';
import {
  getCatalogFullState,
  getCatalogSyncStatus,
  listAvailableCatalogs,
  switchCatalog,
  disconnectCatalogFromWaba,
  createNewCatalog,
  deleteCatalog,
} from '../../../api/restaurant';

interface CatalogSummary {
  id: string;
  name?: string;
  product_count?: number;
  connected?: boolean;
}

interface CatalogState {
  catalogExists?: boolean;
  catalogId?: string;
  catalogName?: string;
  catalogLinkedToWhatsapp?: boolean;
  lastSyncStatus?: string;
  availableCatalogs?: CatalogSummary[];
}

interface SyncStatus {
  lastSyncToMeta?: string | null;
}

interface CatalogsListResponse {
  catalogs?: CatalogSummary[];
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const yr = Math.floor(day / 365);
  return `${yr} year${yr === 1 ? '' : 's'} ago`;
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e?.response?.data?.error || e?.message || fallback;
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  busy?: boolean;
}

function Modal({ open, onClose, title, children, busy = false }: ModalProps) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={busy ? undefined : onClose}
      className="fixed inset-0 bg-black/45 z-9999 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-[10px] max-w-[500px] w-full shadow-[0_12px_40px_rgba(0,0,0,0.18)] overflow-hidden"
      >
        <div className="py-[0.85rem] px-4 border-b border-rim flex items-center justify-between">
          <h3 className="m-0 text-base">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`bg-transparent border-0 text-[1.2rem] text-dim py-[0.2rem] px-[0.4rem] ${
              busy ? 'cursor-not-allowed' : 'cursor-pointer'
            }`}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export default function CatalogManagementCard() {
  const { showToast } = useToast();

  const [catalogState, setCatalogState] = useState<CatalogState | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
  const [disconnectOpen, setDisconnectOpen] = useState<boolean>(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const [state, sync] = await Promise.all([
        getCatalogFullState() as Promise<CatalogState | null>,
        (getCatalogSyncStatus() as Promise<SyncStatus | null>).catch(() => null),
      ]);
      setCatalogState(state);
      setSyncStatus(sync);
    } catch (e: unknown) {
      setLoadErr(errorMessage(e, 'Failed to load catalog state'));
      setCatalogState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  return (
    <>
      <div className="card mb-[1.2rem]">
        <div className="ch"><h3>Meta Catalog</h3></div>
        <div className="cb">
          {loading && !catalogState ? (
            <LoadingState />
          ) : loadErr ? (
            <ErrorState message={loadErr} onRetry={refetch} />
          ) : catalogState?.catalogExists ? (
            <ConnectedState
              state={catalogState}
              syncStatus={syncStatus}
              onSwitch={() => setPickerOpen(true)}
              onCreate={() => setCreateOpen(true)}
              onDelete={() => setDeleteOpen(true)}
              onDisconnect={() => setDisconnectOpen(true)}
            />
          ) : (
            <EmptyState
              onConnect={() => setPickerOpen(true)}
              onCreate={() => setCreateOpen(true)}
            />
          )}
        </div>
      </div>

      <PickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        currentCatalogId={catalogState?.catalogId}
        seedCatalogs={catalogState?.availableCatalogs || []}
        onSwitched={async (newId, newName, result) => {
          setPickerOpen(false);
          // meta_sync === false means the DB write succeeded but the Meta
          // commerce_settings update was skipped or failed (e.g. phone
          // number not registered yet, scope missing, Meta API error).
          // Surface as a warning so the user re-runs after fixing the
          // underlying setup instead of trusting a false-positive success.
          if (result.meta_sync === false) {
            showToast(
              `Catalog saved but Meta sync failed: ${result.meta_error || 'unknown error'}. Try reconnecting or check WhatsApp settings.`,
              'warning',
            );
          } else {
            showToast(`Switched to ${newName}`, 'success');
          }
          await refetch();
          // eslint-disable-next-line no-unused-expressions
          newId;
        }}
      />

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (name) => {
          setCreateOpen(false);
          showToast(`Created catalog "${name}"`, 'success');
          await refetch();
        }}
      />

      <DeleteModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        catalogId={catalogState?.catalogId}
        catalogName={catalogState?.catalogName}
        isCurrentlyConnected
        onDeleted={async () => {
          setDeleteOpen(false);
          showToast('Catalog deleted', 'success');
          await refetch();
        }}
      />

      <DisconnectModal
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        catalogName={catalogState?.catalogName}
        onDisconnected={async () => {
          setDisconnectOpen(false);
          showToast('Catalog disconnected from WhatsApp', 'success');
          await refetch();
        }}
      />
    </>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center gap-[0.6rem] py-4 text-dim">
      <span className="spin" aria-hidden="true" />
      <span>Loading catalog state…</span>
    </div>
  );
}

interface ErrorStateProps { message: string; onRetry: () => void }

function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="py-3 px-[0.9rem] bg-[#fef2f2] border border-[#fecaca] rounded-lg text-[#b91c1c] text-[0.84rem] flex items-center justify-between gap-[0.6rem]">
      <span>Failed to load: {message}</span>
      <button type="button" className="btn-g btn-sm" onClick={onRetry}>Retry</button>
    </div>
  );
}

interface EmptyStateProps { onConnect: () => void; onCreate: () => void }

function EmptyState({ onConnect, onCreate }: EmptyStateProps) {
  return (
    <div>
      <div className="font-semibold text-[0.92rem] mb-[0.3rem]">
        No catalog connected
      </div>
      <div className="text-dim text-[0.82rem] mb-[0.9rem]">
        Connect a Meta Product Catalog to enable WhatsApp ordering.
      </div>
      <div className="flex gap-2 flex-wrap">
        <button type="button" className="btn-g btn-sm" onClick={onConnect}>
          Connect existing catalog
        </button>
        <button type="button" className="btn-p btn-sm" onClick={onCreate}>
          Create new catalog
        </button>
      </div>
    </div>
  );
}

interface ConnectedStateProps {
  state: CatalogState;
  syncStatus: SyncStatus | null;
  onSwitch: () => void;
  onCreate: () => void;
  onDelete: () => void;
  onDisconnect: () => void;
}

function ConnectedState({ state, syncStatus, onSwitch, onCreate, onDelete, onDisconnect }: ConnectedStateProps) {
  const connected = (state.availableCatalogs || []).find((c) => c.id === state.catalogId);
  const itemCount = connected?.product_count;
  const lastSync = syncStatus?.lastSyncToMeta || null;
  const lastSyncStatus = state.lastSyncStatus;

  return (
    <div>
      <div className="mb-[0.85rem]">
        <div className="font-bold text-base text-tx mb-[0.3rem]">
          {state.catalogName || 'Menu Catalog'}
        </div>
        <div
          title={state.catalogId}
          className="font-mono text-[0.78rem] text-dim mb-[0.45rem] whitespace-nowrap overflow-hidden text-ellipsis"
        >
          {state.catalogId}
        </div>
        <div className="text-[0.82rem] text-tx mb-[0.2rem]">
          {itemCount == null ? 'Item count unavailable' : `${itemCount} item${itemCount === 1 ? '' : 's'} in catalog`}
        </div>
        <div className="text-[0.78rem] text-dim">
          {lastSyncStatus === 'failed'
            ? `Last sync failed${lastSync ? ` (${formatRelativeTime(lastSync)})` : ''}`
            : lastSync
              ? `Synced ${formatRelativeTime(lastSync)}`
              : 'Never synced'}
        </div>
        {!state.catalogLinkedToWhatsapp && (
          <div className="mt-[0.45rem] text-[0.78rem] text-gold">
            ⚠ Catalog exists but is not linked to WhatsApp.
          </div>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <button type="button" className="btn-g btn-sm" onClick={onSwitch}>Switch catalog</button>
        <button type="button" className="btn-g btn-sm" onClick={onCreate}>Create new catalog</button>
        <button
          type="button"
          className="btn-g btn-sm text-[#dc2626] border-[#dc2626]"
          onClick={onDisconnect}
        >
          Disconnect from WhatsApp
        </button>
        <button type="button" className="btn-del btn-sm" onClick={onDelete}>Delete this catalog</button>
      </div>
    </div>
  );
}

// Backend partial-success shape — services/catalog.js:switchCatalog
// returns { ..., meta_sync: boolean, meta_error?: string } so the dashboard
// can warn instead of false-positive when Commerce Manager link silently
// fails (e.g. phone_number_id missing, scope mismatch, Meta API error).
interface SwitchResult {
  meta_sync?: boolean;
  meta_error?: string;
}

interface PickerModalProps {
  open: boolean;
  onClose: () => void;
  currentCatalogId?: string;
  seedCatalogs: CatalogSummary[];
  onSwitched: (newId: string, newName: string, result: SwitchResult) => void;
}

function PickerModal({ open, onClose, currentCatalogId, seedCatalogs, onSwitched }: PickerModalProps) {
  const [list, setList] = useState<CatalogSummary[]>(seedCatalogs);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setList(seedCatalogs || []);
      setSelected(null);
      setErr(null);
      setBusy(false);
      setRefreshing(false);
    }
  }, [open, seedCatalogs]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setErr(null);
    try {
      const data = (await listAvailableCatalogs({ refresh: true })) as CatalogsListResponse | null;
      setList(data?.catalogs || []);
    } catch (e: unknown) {
      setErr(errorMessage(e, 'Refresh failed'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleConfirm = async () => {
    if (!selected || selected === currentCatalogId) return;
    setBusy(true); setErr(null);
    try {
      const res = (await switchCatalog(selected)) as SwitchResult | null;
      const chosen = list.find((c) => c.id === selected);
      onSwitched(selected, chosen?.name || 'catalog', res || {});
    } catch (e: unknown) {
      setErr(errorMessage(e, 'Switch failed'));
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Select a catalog" busy={busy}>
      <div className="mb-[0.7rem] flex justify-between items-center">
        <span className="text-[0.78rem] text-dim">
          {list.length} {list.length === 1 ? 'catalog' : 'catalogs'} available
        </span>
        <button type="button" className="btn-g btn-sm" onClick={handleRefresh} disabled={refreshing || busy}>
          {refreshing ? 'Refreshing…' : 'Refresh list'}
        </button>
      </div>

      {list.length === 0 ? (
        <div className="p-4 text-center text-dim text-[0.84rem]">
          No catalogs found. Try refreshing, or create a new one.
        </div>
      ) : (
        <div className="max-h-[320px] overflow-y-auto overflow-x-hidden border border-rim rounded-md">
          {list.map((c) => {
            const isCurrent = c.id === currentCatalogId;
            return (
              <label
                key={c.id}
                className={`flex items-center gap-[0.6rem] py-[0.6rem] px-3 border-b border-rim w-full box-border ${
                  isCurrent ? 'cursor-default opacity-70' : 'cursor-pointer opacity-100'
                } ${
                  selected === c.id ? 'bg-[rgba(79,70,229,0.06)]' : 'bg-transparent'
                }`}
              >
                <input
                  type="radio"
                  name="catalog-pick"
                  value={c.id}
                  checked={selected === c.id}
                  disabled={isCurrent || busy}
                  onChange={() => setSelected(c.id)}
                  className="shrink-0"
                />
                <div className="flex-1 min-w-0 flex flex-col gap-[0.2rem]">
                  <div className="flex items-center gap-2 text-[0.86rem]">
                    <span
                      title={c.name || 'Unnamed catalog'}
                      className="flex-1 min-w-0 font-semibold whitespace-nowrap overflow-hidden text-ellipsis"
                    >
                      {c.name || 'Unnamed catalog'}
                    </span>
                    {isCurrent && (
                      <span className="shrink-0 text-[0.7rem] font-medium text-wa bg-[rgba(22,163,74,0.1)] py-[0.05rem] px-[0.4rem] rounded-full">
                        Connected
                      </span>
                    )}
                    {!isCurrent && c.connected && (
                      <span className="shrink-0 text-[0.7rem] font-medium text-dim bg-surface2 py-[0.05rem] px-[0.4rem] rounded-full">
                        Linked to WhatsApp
                      </span>
                    )}
                  </div>
                  <div
                    title={c.id}
                    className="font-mono text-[0.7rem] text-dim whitespace-nowrap overflow-hidden text-ellipsis"
                  >
                    {c.id}
                  </div>
                  {c.product_count != null && (
                    <div className="text-[0.74rem] text-dim">
                      {c.product_count} item{c.product_count === 1 ? '' : 's'}
                    </div>
                  )}
                </div>
              </label>
            );
          })}
        </div>
      )}

      {err && (
        <div className="mt-[0.6rem] text-[#b91c1c] text-[0.8rem]">{err}</div>
      )}

      <div className="mt-[0.9rem] flex gap-2 justify-end">
        <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn-p btn-sm"
          onClick={handleConfirm}
          disabled={!selected || selected === currentCatalogId || busy}
        >
          {busy ? 'Switching…' : (currentCatalogId ? 'Switch to selected' : 'Connect')}
        </button>
      </div>
    </Modal>
  );
}

interface CreateModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}

function CreateModal({ open, onClose, onCreated }: CreateModalProps) {
  const [name, setName] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setName(''); setBusy(false); setErr(null); }
  }, [open]);

  const trimmed = name.trim();
  const valid = trimmed.length >= 3 && trimmed.length <= 50;

  const handleCreate = async () => {
    if (!valid) return;
    setBusy(true); setErr(null);
    try {
      await createNewCatalog(trimmed);
      onCreated(trimmed);
    } catch (e: unknown) {
      setErr(errorMessage(e, 'Create failed'));
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create new catalog" busy={busy}>
      <label className="block text-[0.82rem] text-dim mb-[0.3rem]">
        Catalog name
      </label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Beyond Snacks - Main Menu"
        maxLength={60}
        disabled={busy}
        className="w-full py-[0.55rem] px-3 border border-rim rounded-md text-[0.88rem] bg-white"
      />
      <div className="mt-[0.3rem] text-[0.72rem] text-dim">
        3–50 characters.{trimmed.length > 0 && ` (${trimmed.length})`}
      </div>

      {err && <div className="mt-[0.6rem] text-[#b91c1c] text-[0.8rem]">{err}</div>}

      <div className="mt-[0.9rem] flex gap-2 justify-end">
        <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn-p btn-sm" onClick={handleCreate} disabled={!valid || busy}>
          {busy ? 'Creating…' : 'Create catalog'}
        </button>
      </div>
    </Modal>
  );
}

interface DeleteModalProps {
  open: boolean;
  onClose: () => void;
  catalogId?: string;
  catalogName?: string;
  isCurrentlyConnected: boolean;
  onDeleted: () => void;
}

function DeleteModal({ open, onClose, catalogId, catalogName, isCurrentlyConnected, onDeleted }: DeleteModalProps) {
  const [typed, setTyped] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setTyped(''); setBusy(false); setErr(null); }
  }, [open]);

  const matches = catalogName != null && typed.trim() === catalogName.trim();

  const handleDelete = async () => {
    if (!matches || !catalogId) return;
    setBusy(true); setErr(null);
    try {
      await deleteCatalog(catalogId);
      onDeleted();
    } catch (e: unknown) {
      setErr(errorMessage(e, 'Delete failed'));
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Delete this catalog?" busy={busy}>
      <div className="bg-[#fef2f2] border border-[#fecaca] rounded-md py-3 px-[0.85rem] text-[#7f1d1d] text-[0.82rem] mb-[0.85rem]">
        <div className="font-bold text-[#b91c1c] mb-[0.3rem]">
          ⚠ This cannot be undone
        </div>
        This will permanently delete the catalog from your Meta business account.
        All items in this catalog will be removed.
        {isCurrentlyConnected && (
          <>
            <br /><br />
            <strong>This is your currently connected catalog.</strong> Orders placed on
            items from this catalog will no longer resolve.
          </>
        )}
      </div>

      <label className="block text-[0.78rem] text-dim mb-1">
        Type the catalog name to confirm: <code className="text-tx">{catalogName || '(unknown)'}</code>
      </label>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        disabled={busy}
        placeholder={catalogName || ''}
        className="w-full py-2 px-[0.7rem] border border-rim rounded-md text-[0.85rem] bg-white"
      />

      {err && <div className="mt-[0.6rem] text-[#b91c1c] text-[0.8rem]">{err}</div>}

      <div className="mt-[0.9rem] flex gap-2 justify-end">
        <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn-del btn-sm"
          onClick={handleDelete}
          disabled={!matches || busy}
        >
          {busy ? 'Deleting…' : 'Delete catalog'}
        </button>
      </div>
    </Modal>
  );
}

interface DisconnectModalProps {
  open: boolean;
  onClose: () => void;
  catalogName?: string;
  onDisconnected: () => void;
}

function DisconnectModal({ open, onClose, catalogName, onDisconnected }: DisconnectModalProps) {
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setBusy(false); setErr(null); }
  }, [open]);

  const handleConfirm = async () => {
    setBusy(true); setErr(null);
    try {
      await disconnectCatalogFromWaba();
      onDisconnected();
    } catch (e: unknown) {
      setErr(errorMessage(e, 'Disconnect failed'));
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Disconnect catalog from WhatsApp?" busy={busy}>
      <div className="bg-[#fffbeb] border border-[#fde68a] rounded-md py-3 px-[0.85rem] text-[#92400e] text-[0.82rem] mb-[0.85rem]">
        The catalog{catalogName ? ` "${catalogName}"` : ''} will remain in your Meta
        business account but will no longer be available to customers through WhatsApp.
        You can reconnect it later.
      </div>

      {err && <div className="mb-[0.6rem] text-[#b91c1c] text-[0.8rem]">{err}</div>}

      <div className="flex gap-2 justify-end">
        <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn-del btn-sm"
          onClick={handleConfirm}
          disabled={busy}
        >
          {busy ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
    </Modal>
  );
}
