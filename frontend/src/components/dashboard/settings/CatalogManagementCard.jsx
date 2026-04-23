import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../Toast.jsx';
import {
  getCatalogFullState,
  getCatalogSyncStatus,
  listAvailableCatalogs,
  switchCatalog,
  disconnectCatalogFromWaba,
  createNewCatalog,
  deleteCatalog,
} from '../../../api/restaurant.js';

// Meta Catalog management card. Renders below WhatsApp Connection in
// Settings → WhatsApp. Five operations: display connected, switch,
// disconnect, create new, delete. All destructive actions confirmed
// via inline modal. State source: GET /catalog/full-state +
// /catalog/sync-status, refetched after every mutation. Picker hydrates
// instantly from full-state.availableCatalogs; "Refresh list" inside
// the picker hits /catalogs?refresh=true for a live Meta fetch.

// ─── helpers ────────────────────────────────────────────────────────
function formatRelativeTime(iso) {
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

function errorMessage(err, fallback) {
  return err?.response?.data?.error || err?.message || fallback;
}

// ─── inline modal primitive ────────────────────────────────────────
function Modal({ open, onClose, title, children, busy = false }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
        zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 10, maxWidth: 500, width: '100%',
          boxShadow: '0 12px 40px rgba(0,0,0,.18)', overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '.85rem 1rem', borderBottom: '1px solid var(--rim)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}
        >
          <h3 style={{ margin: 0, fontSize: '1rem' }}>{title}</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              background: 'transparent', border: 'none', fontSize: '1.2rem',
              color: 'var(--dim)', cursor: busy ? 'not-allowed' : 'pointer', padding: '.2rem .4rem',
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div style={{ padding: '1rem' }}>{children}</div>
      </div>
    </div>
  );
}

// ─── main component ────────────────────────────────────────────────
export default function CatalogManagementCard() {
  const { showToast } = useToast();

  const [catalogState, setCatalogState] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const [state, sync] = await Promise.all([
        getCatalogFullState(),
        getCatalogSyncStatus().catch(() => null), // sync-status is enrichment, not blocking
      ]);
      setCatalogState(state);
      setSyncStatus(sync);
    } catch (e) {
      setLoadErr(errorMessage(e, 'Failed to load catalog state'));
      setCatalogState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  // ─── render branches ─────────────────────────────────────────────
  return (
    <>
      <div className="card" style={{ marginBottom: '1.2rem' }}>
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
        onSwitched={async (newId, newName) => {
          setPickerOpen(false);
          showToast(`Switched to ${newName}`, 'success');
          await refetch();
          // Cache invalidate is server-side responsibility; nothing further here.
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

// ─── state-specific render blocks ───────────────────────────────────
function LoadingState() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '1rem 0', color: 'var(--dim)' }}>
      <span className="spin" aria-hidden="true" />
      <span>Loading catalog state…</span>
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div style={{
      padding: '.75rem .9rem', background: '#fef2f2', border: '1px solid #fecaca',
      borderRadius: 8, color: '#b91c1c', fontSize: '.84rem',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.6rem',
    }}
    >
      <span>Failed to load: {message}</span>
      <button type="button" className="btn-g btn-sm" onClick={onRetry}>Retry</button>
    </div>
  );
}

function EmptyState({ onConnect, onCreate }) {
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: '.92rem', marginBottom: '.3rem' }}>
        No catalog connected
      </div>
      <div style={{ color: 'var(--dim)', fontSize: '.82rem', marginBottom: '.9rem' }}>
        Connect a Meta Product Catalog to enable WhatsApp ordering.
      </div>
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
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

function ConnectedState({ state, syncStatus, onSwitch, onCreate, onDelete, onDisconnect }) {
  // Item count comes from availableCatalogs[i].product_count where connected=true
  // (full-state doesn't expose it on the top-level object).
  const connected = (state.availableCatalogs || []).find((c) => c.id === state.catalogId);
  const itemCount = connected?.product_count;
  const lastSync = syncStatus?.lastSyncToMeta || null;
  const lastSyncStatus = state.lastSyncStatus; // 'never' | 'success' | 'failed'

  return (
    <div>
      <div style={{ marginBottom: '.85rem' }}>
        <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--tx)', marginBottom: '.3rem' }}>
          {state.catalogName || 'Menu Catalog'}
        </div>
        <div
          title={state.catalogId}
          style={{
            fontFamily: 'monospace', fontSize: '.78rem', color: 'var(--dim)', marginBottom: '.45rem',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {state.catalogId}
        </div>
        <div style={{ fontSize: '.82rem', color: 'var(--tx)', marginBottom: '.2rem' }}>
          {itemCount == null ? 'Item count unavailable' : `${itemCount} item${itemCount === 1 ? '' : 's'} in catalog`}
        </div>
        <div style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
          {lastSyncStatus === 'failed'
            ? `Last sync failed${lastSync ? ` (${formatRelativeTime(lastSync)})` : ''}`
            : lastSync
              ? `Synced ${formatRelativeTime(lastSync)}`
              : 'Never synced'}
        </div>
        {!state.catalogLinkedToWhatsapp && (
          <div style={{ marginTop: '.45rem', fontSize: '.78rem', color: 'var(--gold, #d97706)' }}>
            ⚠ Catalog exists but is not linked to WhatsApp.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn-g btn-sm" onClick={onSwitch}>Switch catalog</button>
        <button type="button" className="btn-g btn-sm" onClick={onCreate}>Create new catalog</button>
        <button type="button" className="btn-g btn-sm" onClick={onDisconnect}
          style={{ color: '#dc2626', borderColor: '#dc2626' }}
        >
          Disconnect from WhatsApp
        </button>
        <button type="button" className="btn-del btn-sm" onClick={onDelete}>Delete this catalog</button>
      </div>
    </div>
  );
}

// ─── modals ────────────────────────────────────────────────────────
function PickerModal({ open, onClose, currentCatalogId, seedCatalogs, onSwitched }) {
  const [list, setList] = useState(seedCatalogs);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Reset on open: re-seed from latest props, clear selection/error.
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
      const data = await listAvailableCatalogs({ refresh: true });
      setList(data?.catalogs || []);
    } catch (e) {
      setErr(errorMessage(e, 'Refresh failed'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleConfirm = async () => {
    if (!selected || selected === currentCatalogId) return;
    setBusy(true); setErr(null);
    try {
      await switchCatalog(selected);
      const chosen = list.find((c) => c.id === selected);
      onSwitched(selected, chosen?.name || 'catalog');
    } catch (e) {
      setErr(errorMessage(e, 'Switch failed'));
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Select a catalog" busy={busy}>
      <div style={{ marginBottom: '.7rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
          {list.length} {list.length === 1 ? 'catalog' : 'catalogs'} available
        </span>
        <button type="button" className="btn-g btn-sm" onClick={handleRefresh} disabled={refreshing || busy}>
          {refreshing ? 'Refreshing…' : 'Refresh list'}
        </button>
      </div>

      {list.length === 0 ? (
        <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--dim)', fontSize: '.84rem' }}>
          No catalogs found. Try refreshing, or create a new one.
        </div>
      ) : (
        <div style={{
          maxHeight: 320, overflowY: 'auto', overflowX: 'hidden',
          border: '1px solid var(--rim)', borderRadius: 6,
        }}
        >
          {list.map((c) => {
            const isCurrent = c.id === currentCatalogId;
            return (
              <label
                key={c.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: '.6rem',
                  padding: '.6rem .75rem', borderBottom: '1px solid var(--rim)',
                  cursor: isCurrent ? 'default' : 'pointer',
                  background: selected === c.id ? 'rgba(79,70,229,.06)' : 'transparent',
                  opacity: isCurrent ? 0.7 : 1,
                  width: '100%', boxSizing: 'border-box',
                }}
              >
                <input
                  type="radio"
                  name="catalog-pick"
                  value={c.id}
                  checked={selected === c.id}
                  disabled={isCurrent || busy}
                  onChange={() => setSelected(c.id)}
                  style={{ flexShrink: 0 }}
                />
                <div style={{
                  flex: 1, minWidth: 0,
                  display: 'flex', flexDirection: 'column', gap: '0.2rem',
                }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    fontSize: '.86rem',
                  }}
                  >
                    <span
                      title={c.name || 'Unnamed catalog'}
                      style={{
                        flex: 1, minWidth: 0, fontWeight: 600,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}
                    >
                      {c.name || 'Unnamed catalog'}
                    </span>
                    {isCurrent && (
                      <span style={{
                        flexShrink: 0, fontSize: '.7rem', fontWeight: 500,
                        color: 'var(--wa, #16a34a)', background: 'rgba(22,163,74,.1)',
                        padding: '.05rem .4rem', borderRadius: 999,
                      }}
                      >
                        Connected
                      </span>
                    )}
                    {!isCurrent && c.connected && (
                      <span style={{
                        flexShrink: 0, fontSize: '.7rem', fontWeight: 500,
                        color: 'var(--dim)', background: 'var(--surface2,#f4f4f5)',
                        padding: '.05rem .4rem', borderRadius: 999,
                      }}
                      >
                        Linked to WhatsApp
                      </span>
                    )}
                  </div>
                  <div
                    title={c.id}
                    style={{
                      fontFamily: 'monospace', fontSize: '.7rem', color: 'var(--dim)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}
                  >
                    {c.id}
                  </div>
                  {c.product_count != null && (
                    <div style={{ fontSize: '.74rem', color: 'var(--dim)' }}>
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
        <div style={{ marginTop: '.6rem', color: '#b91c1c', fontSize: '.8rem' }}>{err}</div>
      )}

      <div style={{ marginTop: '.9rem', display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
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

function CreateModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

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
    } catch (e) {
      setErr(errorMessage(e, 'Create failed'));
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create new catalog" busy={busy}>
      <label style={{ display: 'block', fontSize: '.82rem', color: 'var(--dim)', marginBottom: '.3rem' }}>
        Catalog name
      </label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Beyond Snacks - Main Menu"
        maxLength={60}
        disabled={busy}
        style={{
          width: '100%', padding: '.55rem .75rem', border: '1px solid var(--rim)',
          borderRadius: 6, fontSize: '.88rem', background: '#fff',
        }}
      />
      <div style={{ marginTop: '.3rem', fontSize: '.72rem', color: 'var(--dim)' }}>
        3–50 characters.{trimmed.length > 0 && ` (${trimmed.length})`}
      </div>

      {err && <div style={{ marginTop: '.6rem', color: '#b91c1c', fontSize: '.8rem' }}>{err}</div>}

      <div style={{ marginTop: '.9rem', display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
        <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn-p btn-sm" onClick={handleCreate} disabled={!valid || busy}>
          {busy ? 'Creating…' : 'Create catalog'}
        </button>
      </div>
    </Modal>
  );
}

function DeleteModal({ open, onClose, catalogId, catalogName, isCurrentlyConnected, onDeleted }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

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
    } catch (e) {
      setErr(errorMessage(e, 'Delete failed'));
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Delete this catalog?" busy={busy}>
      <div style={{
        background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6,
        padding: '.75rem .85rem', color: '#7f1d1d', fontSize: '.82rem', marginBottom: '.85rem',
      }}
      >
        <div style={{ fontWeight: 700, color: '#b91c1c', marginBottom: '.3rem' }}>
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

      <label style={{ display: 'block', fontSize: '.78rem', color: 'var(--dim)', marginBottom: '.25rem' }}>
        Type the catalog name to confirm: <code style={{ color: 'var(--tx)' }}>{catalogName || '(unknown)'}</code>
      </label>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        disabled={busy}
        placeholder={catalogName || ''}
        style={{
          width: '100%', padding: '.5rem .7rem', border: '1px solid var(--rim)',
          borderRadius: 6, fontSize: '.85rem', background: '#fff',
        }}
      />

      {err && <div style={{ marginTop: '.6rem', color: '#b91c1c', fontSize: '.8rem' }}>{err}</div>}

      <div style={{ marginTop: '.9rem', display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
        <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn-sm"
          onClick={handleDelete}
          disabled={!matches || busy}
          style={{
            background: matches ? '#dc2626' : '#fca5a5', color: '#fff',
            border: 'none', borderRadius: 6, padding: '.4rem .9rem',
            fontWeight: 600, cursor: matches && !busy ? 'pointer' : 'not-allowed',
          }}
        >
          {busy ? 'Deleting…' : 'Delete catalog'}
        </button>
      </div>
    </Modal>
  );
}

function DisconnectModal({ open, onClose, catalogName, onDisconnected }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (open) { setBusy(false); setErr(null); }
  }, [open]);

  const handleConfirm = async () => {
    setBusy(true); setErr(null);
    try {
      await disconnectCatalogFromWaba();
      onDisconnected();
    } catch (e) {
      setErr(errorMessage(e, 'Disconnect failed'));
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Disconnect catalog from WhatsApp?" busy={busy}>
      <div style={{
        background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6,
        padding: '.75rem .85rem', color: '#92400e', fontSize: '.82rem', marginBottom: '.85rem',
      }}
      >
        The catalog{catalogName ? ` "${catalogName}"` : ''} will remain in your Meta
        business account but will no longer be available to customers through WhatsApp.
        You can reconnect it later.
      </div>

      {err && <div style={{ marginBottom: '.6rem', color: '#b91c1c', fontSize: '.8rem' }}>{err}</div>}

      <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
        <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn-sm"
          onClick={handleConfirm}
          disabled={busy}
          style={{
            background: '#d97706', color: '#fff', border: 'none',
            borderRadius: 6, padding: '.4rem .9rem', fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
    </Modal>
  );
}
