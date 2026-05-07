'use client';

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StaffAccess from '../../../components/admin/StaffAccess';
import {
  getAdminRestaurants,
  updateAdminRestaurant,
  setRestaurantCampaignCap,
  deleteAdminRestaurant,
} from '../../../api/admin';

interface OrdersBreakdown {
  total?: number;
  delivered?: number;
  pending?: number;
  confirmed?: number;
  preparing?: number;
  out_for_delivery?: number;
  cancelled?: number;
}

interface RestaurantRowData {
  id: string;
  business_name?: string;
  registered_business_name?: string;
  owner_name?: string;
  slug?: string;
  branch_count?: number;
  catalog_count?: number;
  orders?: OrdersBreakdown;
  fulfillment_pct?: number;
  issues?: number;
  revenue_rs?: number | string;
  status?: string;
  campaign_daily_cap?: number | null;
  created_at?: string;
}

interface PendingAction {
  id: string;
  kind: 'status' | 'cap' | 'delete' | 'staffPin';
  target?: string;
}

interface BadgeMeta { color: string; label: string }

const STATUS_BADGE: Record<string, BadgeMeta> = {
  active:     { color: 'var(--gb-wa-500)', label: 'Active' },
  suspended:  { color: 'var(--gb-red-500)', label: 'Suspended' },
  onboarding: { color: '#3b82f6', label: 'Onboarding' },
  pending:    { color: 'var(--gb-amber-500)', label: 'Pending' },
};

function fmtInr(n: number | string | null | undefined): string {
  const v = Number(n || 0);
  try {
    return v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  } catch {
    return String(v);
  }
}

export default function AdminRestaurantsPage() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<RestaurantRowData[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = (await getAdminRestaurants()) as RestaurantRowData[] | null;
      setRows(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo<RestaurantRowData[]>(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((r) =>
      (r.business_name || '').toLowerCase().includes(q) ||
      (r.owner_name || '').toLowerCase().includes(q) ||
      (r.id || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const doStatus = async (r: RestaurantRowData, status: string) => {
    setRowBusy(r.id);
    try {
      await updateAdminRestaurant(r.id, { status });
      showToast(`${r.business_name} is now ${status}`, 'success');
      setPending(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Update failed', 'error');
    } finally { setRowBusy(null); }
  };

  const doCap = async (r: RestaurantRowData, capInput: string) => {
    let payload: number | null;
    if (capInput.trim() === '') payload = null;
    else {
      const n = Number(capInput);
      if (!Number.isFinite(n) || n < 0) { showToast('Invalid number', 'error'); return; }
      payload = n;
    }
    setRowBusy(r.id);
    try {
      await setRestaurantCampaignCap(r.id, payload);
      showToast(`Cap updated for "${r.business_name}"`, 'success');
      setPending(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Cap update failed', 'error');
    } finally { setRowBusy(null); }
  };

  const doDelete = async (r: RestaurantRowData, typedName: string) => {
    if (typedName.trim().toLowerCase() !== (r.business_name || '').trim().toLowerCase()) {
      showToast('Name did not match — deletion cancelled', 'error');
      return;
    }
    setRowBusy(r.id);
    try {
      await deleteAdminRestaurant(r.id);
      showToast(`"${r.business_name}" deleted and archived`, 'success');
      setPending(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
    } finally { setRowBusy(null); }
  };

  return (
    <div>
      <div className="card">
        <div className="ch justify-between flex-wrap gap-[0.4rem]">
          <h3>🏪 Restaurant Directory</h3>
          <div className="flex gap-[0.4rem] items-center">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, owner, ID…"
              className="py-[0.3rem] px-[0.55rem] border border-rim rounded-md text-[0.8rem] w-[240px]"
            />
            <button type="button" className="btn-g btn-sm" onClick={load} disabled={loading}>
              {loading ? '…' : '↻ Refresh'}
            </button>
          </div>
        </div>
        <div className="cb">
          {loading ? (
            <p className="text-dim">Loading…</p>
          ) : !filtered.length ? (
            <p className="text-dim">
              {rows.length ? 'No restaurants match your search.' : 'No restaurants yet.'}
            </p>
          ) : (
            <div className="tbl-card overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[0.72rem] text-dim uppercase">
                    <th className="p-2">Business</th>
                    <th className="p-2">Owner</th>
                    <th className="p-2 text-center">Branches</th>
                    <th className="p-2 text-center">Catalogs</th>
                    <th className="p-2 text-center">Orders</th>
                    <th className="p-2 text-center">Fulfil%</th>
                    <th className="p-2 text-center">Issues</th>
                    <th className="p-2">Revenue</th>
                    <th className="p-2">Status</th>
                    <th className="p-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <RestaurantRow
                      key={r.id}
                      r={r}
                      busy={rowBusy === r.id}
                      pending={pending && pending.id === r.id ? pending : null}
                      onAsk={(kind, extra = {}) => setPending({ id: r.id, kind, ...extra })}
                      onCancel={() => setPending(null)}
                      onStatus={doStatus}
                      onCap={doCap}
                      onDelete={doDelete}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface RestaurantRowProps {
  r: RestaurantRowData;
  busy: boolean;
  pending: PendingAction | null;
  onAsk: (kind: PendingAction['kind'], extra?: Partial<PendingAction>) => void;
  onCancel: () => void;
  onStatus: (r: RestaurantRowData, status: string) => void;
  onCap: (r: RestaurantRowData, val: string) => void;
  onDelete: (r: RestaurantRowData, typed: string) => void;
}

function RestaurantRow({ r, busy, pending, onAsk, onCancel, onStatus, onCap, onDelete }: RestaurantRowProps) {
  const o: OrdersBreakdown = r.orders || {};
  const fpct = r.fulfillment_pct || 0;
  const fColor = fpct >= 80 ? 'var(--gb-wa-500)' : fpct >= 50 ? 'var(--gb-amber-500)' : 'var(--gb-red-500)';
  const badge = STATUS_BADGE[r.status || ''] || { color: 'var(--gb-neutral-500)', label: r.status || '' };
  const orderTip = [
    `Delivered: ${o.delivered || 0}`,
    `Pending: ${o.pending || 0}`,
    `Confirmed: ${o.confirmed || 0}`,
    `Preparing: ${o.preparing || 0}`,
    `Out for Delivery: ${o.out_for_delivery || 0}`,
    `Cancelled: ${o.cancelled || 0}`,
  ].join('\n');

  const staffPinOpen = pending?.kind === 'staffPin';

  return (
    <>
    {/* dynamic borderBottom: hidden when staff PIN row expands below */}
    <tr style={{ borderBottom: staffPinOpen ? 'none' : '1px solid var(--rim)' }}>
      <td data-label="Business" className="p-2">
        <div className="font-semibold text-[0.84rem]">{r.business_name}</div>
        {r.registered_business_name ? (
          <div className="text-dim text-[0.74rem]">{r.registered_business_name}</div>
        ) : null}
        <div className="text-dim text-[0.7rem] font-mono">{(r.id || '').slice(0, 8)}</div>
        {(() => {
          if (!r.created_at) return null;
          const d = new Date(r.created_at);
          if (Number.isNaN(d.getTime())) return null;
          const formatted = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
          return (
            <div className="text-dim text-[0.68rem] opacity-75">Created: {formatted}</div>
          );
        })()}
      </td>
      <td data-label="Owner" className="p-2 text-[0.8rem]">{r.owner_name || '—'}</td>
      <td data-label="Branches" className="p-2 text-center text-[0.82rem]">{r.branch_count ?? 0}</td>
      <td data-label="Catalogs" className="p-2 text-center text-[0.82rem]">{r.catalog_count ?? 0}</td>
      <td data-label="Orders" className="p-2 text-center cursor-help" title={orderTip}>
        <div className="font-semibold text-[0.84rem]">{o.total ?? 0}</div>
        <div className="text-wa-500 text-[0.7rem]">{o.delivered ?? 0} del</div>
      </td>
      <td data-label="Fulfil%" className="p-2 text-center">
        {/* dynamic color: runtime threshold-based fulfilment color */}
        <span style={{ color: fColor }} className="font-semibold">{fpct}%</span>
      </td>
      <td data-label="Issues" className="p-2 text-center">
        {r.issues
          ? <span className="text-red-500 font-semibold">{r.issues}</span>
          : <span className="text-mute">0</span>}
      </td>
      <td data-label="Revenue" className="p-2 text-[0.82rem]">₹{fmtInr(r.revenue_rs)}</td>
      <td data-label="Status" className="p-2">
        {/* dynamic palette: badge tint/border/text derived from runtime status color */}
        <span style={{ background: `${badge.color}15`, color: badge.color, border: `1px solid ${badge.color}30` }} className="inline-block py-[0.1rem] px-[0.4rem] rounded-full text-[0.7rem] font-semibold">
          {badge.label}
        </span>
      </td>
      <td data-label="Actions" className="p-2 text-right whitespace-normal">
        {pending?.kind === 'status' ? (
          <InlineConfirm
            label={`${pending.target === 'suspended' ? 'Suspend' : 'Activate'} "${r.business_name}"?`}
            busy={busy}
            onConfirm={() => onStatus(r, pending.target || '')}
            onCancel={onCancel}
            confirmColor={pending.target === 'suspended' ? 'var(--gb-red-500)' : 'var(--gb-wa-500)'}
          />
        ) : pending?.kind === 'cap' ? (
          <CapEditor
            current={r.campaign_daily_cap}
            busy={busy}
            onConfirm={(val) => onCap(r, val)}
            onCancel={onCancel}
          />
        ) : pending?.kind === 'delete' ? (
          <DeleteEditor
            name={r.business_name || ''}
            busy={busy}
            onConfirm={(typed) => onDelete(r, typed)}
            onCancel={onCancel}
          />
        ) : (
          <div className="inline-flex flex-wrap gap-1 justify-end">
            {r.status === 'active' ? (
              <button type="button" className="btn-del btn-sm" onClick={() => onAsk('status', { target: 'suspended' })} disabled={busy}>
                Suspend
              </button>
            ) : (
              <button type="button" className="btn-p btn-sm" onClick={() => onAsk('status', { target: 'active' })} disabled={busy}>
                Activate
              </button>
            )}
            <button type="button" className="btn-g btn-sm" onClick={() => onAsk('cap')} disabled={busy}>
              Cap
            </button>
            <button
              type="button"
              className="btn-g btn-sm"
              onClick={() => (staffPinOpen ? onCancel() : onAsk('staffPin'))}
              disabled={busy}
              aria-expanded={staffPinOpen}
            >
              {staffPinOpen ? 'Close Staff PIN' : 'Staff PIN'}
            </button>
            <button type="button" className="btn-del btn-sm" onClick={() => onAsk('delete')} disabled={busy}>
              Delete
            </button>
          </div>
        )}
      </td>
    </tr>
    {staffPinOpen && (
      <tr className="border-b border-rim bg-bg-soft">
        <td colSpan={10} className="pt-2 px-3 pb-4">
          <StaffAccess restaurantId={r.id} slug={r.slug} />
        </td>
      </tr>
    )}
    </>
  );
}

interface InlineConfirmProps {
  label: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  confirmColor?: string;
}

function InlineConfirm({ label, busy, onConfirm, onCancel, confirmColor = 'var(--gb-red-500)' }: InlineConfirmProps) {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="text-[0.72rem] text-dim mr-[0.2rem]">{label}</span>
      {/* dynamic background: confirm button tint depends on action (suspend vs activate) */}
      <button type="button" style={{ background: confirmColor }} className="text-neutral-0 border-0 rounded-sm py-[0.15rem] px-2 text-[0.72rem]" onClick={onConfirm} disabled={busy}>
        {busy ? '…' : 'Confirm'}
      </button>
      <button type="button" className="btn-g btn-sm text-[0.72rem]" onClick={onCancel} disabled={busy}>Cancel</button>
    </span>
  );
}

interface CapEditorProps {
  current: number | null | undefined;
  busy: boolean;
  onConfirm: (val: string) => void;
  onCancel: () => void;
}

function CapEditor({ current, busy, onConfirm, onCancel }: CapEditorProps) {
  const [val, setVal] = useState<string>(current == null ? '' : String(current));
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="text-[0.7rem] text-dim">
        Current: {current == null ? '(default)' : current} — new:
      </span>
      <input
        type="number"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="blank = default"
        autoFocus
        className="w-[110px] py-[0.15rem] px-[0.3rem] border border-rim rounded-sm text-[0.72rem]"
      />
      <button type="button" className="btn-p btn-sm text-[0.72rem]" onClick={() => onConfirm(val)} disabled={busy}>
        {busy ? '…' : 'Save'}
      </button>
      <button type="button" className="btn-g btn-sm text-[0.72rem]" onClick={onCancel} disabled={busy}>Cancel</button>
    </span>
  );
}

interface DeleteEditorProps {
  name: string;
  busy: boolean;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
}

function DeleteEditor({ name, busy, onConfirm, onCancel }: DeleteEditorProps) {
  const [typed, setTyped] = useState<string>('');
  const match = typed.trim().toLowerCase() === (name || '').trim().toLowerCase();
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="text-[0.7rem] text-red-500">
        Type &quot;{name}&quot; to confirm:
      </span>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={name}
        autoFocus
        className="w-[140px] py-[0.15rem] px-[0.3rem] border border-rim rounded-sm text-[0.72rem]"
      />
      <button type="button" className={`bg-red-500 text-neutral-0 border-0 rounded-sm py-[0.15rem] px-2 text-[0.72rem] ${match ? 'opacity-100' : 'opacity-50'}`} onClick={() => onConfirm(typed)} disabled={busy || !match}>
        {busy ? '…' : 'Delete'}
      </button>
      <button type="button" className="btn-g btn-sm text-[0.72rem]" onClick={onCancel} disabled={busy}>Cancel</button>
    </span>
  );
}

