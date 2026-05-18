'use client';

// Restaurant-facing POS integrations — one card per branch. Connect
// Petpooja credentials per branch, then sync / manage / disconnect.
// Rendered by the settings page's "Integrations" tab (no props).

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useToast } from '../../Toast';
import {
  getBranches,
  listIntegrations,
  upsertIntegration,
  deleteIntegration,
  syncIntegration,
  type Integration,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

/* ═══ FUTURE FEATURE: additional POS / aggregator platforms ═══
   The per-branch UI below is Petpooja-only today (the only backend
   SERVICES handler wired for restaurant-facing connect). When more
   platforms are enabled, render a platform picker per branch reusing
   these definitions:
     { key:'urbanpiper', name:'UrbanPiper',
       desc:'Connect via UrbanPiper to sync Swiggy/Zomato menus.' }
     { key:'dotpe', name:'DotPe',
       desc:'Sync your DotPe POS menu and push WhatsApp orders.' }
     { key:'swiggy', name:'Swiggy',
       desc:'Requires official Swiggy Partner API access.' }
     { key:'zomato', name:'Zomato',
       desc:'Requires Zomato for Business API credentials.' }
   ═══ END FUTURE FEATURE ═══ */
/* ═══ FUTURE FEATURE: POS_DISABLED flip ═══
   Backend POS integrations were previously gated behind POS_DISABLED.
   They are now live; the per-branch connect/sync/disconnect flow below
   replaces the old "Coming Soon" placeholder + static Sync Log table.
   ═══ END FUTURE FEATURE ═══ */

const PLATFORM = 'petpooja';

interface ApiError {
  response?: { data?: { error?: string } };
  userMessage?: string;
  message?: string;
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as ApiError;
  return e?.response?.data?.error || e?.userMessage || e?.message || fallback;
}

function maskOutlet(v: string | null): string {
  if (!v) return '—';
  return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}

function formatDate(v: string | null): string {
  if (!v) return 'Never';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'Never' : d.toLocaleString();
}

// Read-only display mappers for Petpooja pos_config (fetched/stored by
// the backend on connect/sync — see services/integrations/petpooja.js).
function packagingApplicableLabel(v: string | undefined): string {
  if (!v) return 'None';
  const s = v.toLowerCase();
  if (s.includes('order')) return 'Order';
  if (s.includes('item')) return 'Item';
  return 'None';
}

function packagingTypeLabel(v: string | undefined): string {
  if (v === 'F') return 'Fixed';
  if (v === 'P') return 'Percentage';
  return '—';
}

interface CredsForm {
  outlet_id: string;
}

const EMPTY_FORM: CredsForm = { outlet_id: '' };

export default function IntegrationsSection() {
  const { showToast } = useToast();

  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);

  // Connect/Manage modal — null when closed.
  const [modalBranch, setModalBranch] = useState<Branch | null>(null);
  const [form, setForm] = useState<CredsForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Per-branch action in flight (sync or disconnect).
  const [busyBranchId, setBusyBranchId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [branchList, integrationList] = await Promise.all([
        getBranches(),
        listIntegrations(),
      ]);
      setBranches(Array.isArray(branchList) ? branchList : []);
      setIntegrations(Array.isArray(integrationList) ? integrationList : []);
    } catch (err: unknown) {
      setLoadError(errorMessage(err, 'Could not load integrations'));
    } finally {
      setLoading(false);
    }
  }, []);

  const refetchIntegrations = useCallback(async () => {
    try {
      const list = await listIntegrations();
      setIntegrations(Array.isArray(list) ? list : []);
    } catch (err: unknown) {
      showToast(errorMessage(err, 'Could not refresh integrations'), 'error');
    }
  }, [showToast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  function integrationFor(branchId: string): Integration | undefined {
    return integrations.find((i) => i.platform === PLATFORM && i.branch_id === branchId);
  }

  function isConnected(integration: Integration | undefined): boolean {
    return Boolean(integration && integration.is_active);
  }

  function openModal(branch: Branch, integration: Integration | undefined): void {
    // Never prefill credentials (none are returned by the API and we
    // never cache them). outlet_id is the only non-secret field, so
    // surfacing the current value is safe and avoids re-typing it.
    setForm({ ...EMPTY_FORM, outlet_id: integration?.outlet_id ?? '' });
    setModalBranch(branch);
  }

  function closeModal(): void {
    setModalBranch(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!modalBranch) return;
    setSubmitting(true);
    try {
      await upsertIntegration(PLATFORM, modalBranch.id, {
        outlet_id: form.outlet_id.trim(),
      });
      closeModal();
      await refetchIntegrations();
      showToast('Petpooja credentials saved', 'success');
    } catch (err: unknown) {
      showToast(errorMessage(err, 'Could not save credentials'), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSync(branch: Branch): Promise<void> {
    setBusyBranchId(branch.id);
    try {
      const res = await syncIntegration(PLATFORM, branch.id);
      await refetchIntegrations();
      // Petpooja Sync Now no longer fetches the menu (fetch-menu API is
      // unsupported — only Push Menu works); the backend returns an
      // informational `message`. Surface it as an info notice, NOT an
      // error. Other platforms still return sync stats → generic toast.
      const msg = (res as { message?: string } | null)?.message;
      if (msg) {
        showToast(msg, 'info');
      } else {
        showToast(`Menu sync started for ${branch.name}`, 'success');
      }
    } catch (err: unknown) {
      showToast(errorMessage(err, 'Sync failed'), 'error');
    } finally {
      setBusyBranchId(null);
    }
  }

  async function handleDisconnect(branch: Branch): Promise<void> {
    const ok = window.confirm(
      `Disconnect Petpooja for "${branch.name}"? Menu sync will stop until you reconnect.`,
    );
    if (!ok) return;
    setBusyBranchId(branch.id);
    try {
      await deleteIntegration(PLATFORM, branch.id);
      await refetchIntegrations();
      showToast(`Petpooja disconnected for ${branch.name}`, 'success');
    } catch (err: unknown) {
      showToast(errorMessage(err, 'Could not disconnect'), 'error');
    } finally {
      setBusyBranchId(null);
    }
  }

  return (
    <div>
      <p className="text-dim text-sm mt-0 mb-5">
        Connect Petpooja per branch to sync your menu automatically into GullyBite and
        your WhatsApp Catalog.
      </p>

      {loading && <p className="text-dim p-4">Loading…</p>}

      {!loading && loadError && (
        <div className="card">
          <div className="cb">
            <p className="text-red-500 m-0">{loadError}</p>
            <button type="button" className="btn-g btn-sm mt-3" onClick={() => void loadAll()}>
              Retry
            </button>
          </div>
        </div>
      )}

      {!loading && !loadError && branches.length === 0 && (
        <div className="notice">
          <div className="notice-ico">🏪</div>
          <div className="notice-body">
            <h4>No branches yet</h4>
            <p>
              You need to create at least one branch before connecting POS integrations.
              Open the <strong>Branches</strong> tab above to add one.
            </p>
          </div>
        </div>
      )}

      {!loading && !loadError && branches.length > 0 && (
        <div className="flex flex-col gap-4">
          {branches.map((branch) => {
            const integration = integrationFor(branch.id);
            const connected = isConnected(integration);
            const busy = busyBranchId === branch.id;

            return (
              <div key={branch.id} className="card">
                <div className="ch justify-between">
                  <h3>{branch.name}</h3>
                  <span
                    className={[
                      'inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full border',
                      connected ? 'text-acc border-acc' : 'text-red-500 border-red-500',
                    ].join(' ')}
                  >
                    {connected ? 'Connected' : 'Not Connected'}
                  </span>
                </div>

                <div className="cb">
                  {connected && integration ? (
                    <>
                      <dl className="grid grid-cols-2 gap-y-2 gap-x-3 text-sm m-0">
                        <dt className="text-dim">Outlet ID</dt>
                        <dd className="text-tx m-0 font-mono">{maskOutlet(integration.outlet_id)}</dd>

                        <dt className="text-dim">Sync status</dt>
                        <dd className="text-tx m-0">{integration.sync_status || 'idle'}</dd>

                        <dt className="text-dim">Last synced</dt>
                        <dd className="text-tx m-0">{formatDate(integration.last_synced_at)}</dd>

                        <dt className="text-dim">Items</dt>
                        <dd className="text-tx m-0">{integration.item_count ?? 0}</dd>
                      </dl>

                      {/* Petpooja Configuration — read-only; populated by
                          the backend pos_config, refreshed via Sync Now. */}
                      <div className="mt-4 rounded-md border border-rim p-3">
                        <h4 className="text-tx text-sm font-semibold m-0 mb-2">
                          Petpooja Configuration
                        </h4>
                        {integration.pos_config ? (
                          <dl className="grid grid-cols-2 gap-y-2 gap-x-3 text-sm m-0">
                            <dt className="text-dim">Packaging Charge</dt>
                            <dd className="text-tx m-0">
                              {integration.pos_config.apply_packaging_charge ? 'Yes' : 'No'}
                            </dd>

                            <dt className="text-dim">Applicable On</dt>
                            <dd className="text-tx m-0">
                              {packagingApplicableLabel(integration.pos_config.packaging_applicable_on)}
                            </dd>

                            <dt className="text-dim">Type</dt>
                            <dd className="text-tx m-0">
                              {packagingTypeLabel(integration.pos_config.packaging_charge_type)}
                            </dd>

                            {integration.pos_config.apply_packaging_charge ? (
                              <>
                                <dt className="text-dim">Value</dt>
                                <dd className="text-tx m-0">
                                  ₹{integration.pos_config.packaging_charge_value ?? 0}
                                </dd>
                              </>
                            ) : null}
                          </dl>
                        ) : (
                          <p className="text-dim text-sm m-0">
                            Configuration not yet fetched — click Sync Now to load.
                          </p>
                        )}
                        <p className="text-dim text-xs mt-3 mb-0">
                          Source: Petpooja. Update in Petpooja dashboard, then Sync Now to refresh.
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2 mt-4">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => void handleSync(branch)}
                        >
                          {busy ? 'Working…' : 'Sync Now'}
                        </button>
                        <button
                          type="button"
                          className="btn-g btn-sm"
                          disabled={busy}
                          onClick={() => openModal(branch, integration)}
                        >
                          Manage
                        </button>
                        <button
                          type="button"
                          className="btn-g btn-sm text-red-500 border-red-500"
                          disabled={busy}
                          onClick={() => void handleDisconnect(branch)}
                        >
                          Disconnect
                        </button>
                      </div>
                      <p className="text-dim text-xs mt-2 mb-0">
                        To sync menu changes, click &lsquo;Menu Trigger&rsquo; in your Petpooja dashboard.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-dim text-sm mt-0 mb-4">
                        Petpooja is not connected for this branch.
                      </p>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => openModal(branch, integration)}
                      >
                        {integration ? 'Manage' : 'Connect Petpooja'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalBranch && (
        <div
          className="fixed inset-0 bg-black/50 z-100 flex items-start justify-center py-8 px-4 overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget && !submitting) closeModal();
          }}
        >
          <form className="card max-w-[480px] w-full bg-surface" onSubmit={(e) => void handleSubmit(e)}>
            <div className="ch justify-between">
              <h3>Connect Petpooja — {modalBranch.name}</h3>
              <button type="button" className="btn-g btn-sm" onClick={closeModal} disabled={submitting}>
                ✕
              </button>
            </div>
            <div className="cb">
              <p className="text-dim text-xs mt-0 mb-4">
                Find your outlet ID in your Petpooja dashboard under Settings → Integration code (e.g., n6awxebz)
              </p>

              <div className="mb-3">
                <label htmlFor="int-outlet" className="block text-sm text-tx mb-1">
                  Outlet ID
                </label>
                <input
                  id="int-outlet"
                  className="inp"
                  value={form.outlet_id}
                  onChange={(e) => setForm((f) => ({ ...f, outlet_id: e.target.value }))}
                  autoComplete="off"
                  required
                />
              </div>

              <div className="flex gap-2 justify-end">
                <button type="button" className="btn-g btn-sm" onClick={closeModal} disabled={submitting}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-sm" disabled={submitting}>
                  {submitting ? 'Saving…' : 'Save & Connect'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
