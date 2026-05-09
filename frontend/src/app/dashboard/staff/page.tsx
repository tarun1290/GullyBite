'use client';

// Owner-side staff management page. Lists every staff row under
// /api/restaurant/staff, with inline controls for active toggle,
// edit, reset-PIN, and deactivate.
//
// Auth: implicit. The (dashboard) layout already wraps the route in
// ProtectedRoute role="restaurant", so unauthenticated traffic gets
// bounced before rendering.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import { getBranches } from '../../../api/restaurant';
import {
  deactivateStaff,
  listStaff,
  resetStaffPin,
  updateStaff,
} from '../../../api/staff';
import StaffEditModal from '../../../components/restaurant/staff/StaffEditModal';
import type { Branch, BranchSummary, Staff } from '../../../types';

// Friendly preset → label mapping. Keep in sync with
// StaffEditModal's ROLE_PRESET_OPTIONS.
const PRESET_LABELS: Record<string, string> = {
  cashier: 'Cashier',
  kitchen: 'Kitchen',
  branch_manager: 'Branch Manager',
  owner: 'Owner',
  custom: 'Custom',
};

function countTrue(perms: Record<string, boolean>): number {
  return Object.values(perms || {}).filter(Boolean).length;
}

export default function DashboardStaffPage() {
  const { showToast } = useToast();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingStaff, setEditingStaff] = useState<Staff | null>(null);

  // Inline destructive-confirm tracking. Each row tracks its own
  // pending state separately so a reset-PIN spinner on row A doesn't
  // grey out row B.
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<string | null>(null);
  const [confirmResetPin, setConfirmResetPin] = useState<string | null>(null);
  // Surface the freshly-reset PIN in a banner. Cleared on next action.
  const [resetPinFlash, setResetPinFlash] = useState<{ name: string; pin: string } | null>(null);

  const branchSummaries = useMemo<BranchSummary[]>(() => (
    branches
      .filter((b) => Boolean(b?.id))
      .map((b) => ({ id: b.id, name: b.name || '(unnamed)' }))
  ), [branches]);

  // Map of branch id → name for the chip rendering on each row.
  const branchNameById = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const b of branches) {
      if (b?.id) m[b.id] = b.name || '(unnamed)';
    }
    return m;
  }, [branches]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [list, br] = await Promise.all([
        listStaff(),
        getBranches().catch(() => [] as Branch[]),
      ]);
      setStaff(list);
      setBranches(br);
      setError(null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setError(e?.response?.data?.error || e?.message || 'Failed to load staff');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const onAdd = () => {
    setModalMode('create');
    setEditingStaff(null);
    setModalOpen(true);
  };

  const onEdit = (s: Staff) => {
    setModalMode('edit');
    setEditingStaff(s);
    setModalOpen(true);
  };

  const onSaved = (saved: Staff) => {
    setStaff((cur) => {
      const idx = cur.findIndex((x) => x._id === saved._id);
      if (idx === -1) return [saved, ...cur];
      const next = [...cur];
      next[idx] = saved;
      return next;
    });
  };

  const onToggleActive = async (s: Staff) => {
    if (busyRow) return;
    setBusyRow(s._id);
    try {
      const res = await updateStaff(s._id, { is_active: !s.is_active });
      onSaved(res.staff);
      showToast(res.staff.is_active ? 'Staff activated' : 'Staff deactivated', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Update failed', 'error');
    } finally {
      setBusyRow(null);
    }
  };

  const onResetPin = async (s: Staff) => {
    if (busyRow) return;
    setBusyRow(s._id);
    setConfirmResetPin(null);
    try {
      const res = await resetStaffPin(s._id);
      onSaved(res.staff);
      if (res.generated_pin) {
        setResetPinFlash({ name: res.staff.display_name || res.staff.name || 'Staff', pin: res.generated_pin });
      } else {
        showToast('PIN reset, but no new PIN returned by server', 'error');
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Reset failed', 'error');
    } finally {
      setBusyRow(null);
    }
  };

  const onDeactivate = async (s: Staff) => {
    if (busyRow) return;
    setBusyRow(s._id);
    setConfirmDeactivate(null);
    try {
      await deactivateStaff(s._id);
      // Soft delete — row stays in the table but flips is_active=false.
      // Optimistically reflect that locally and then reload from the
      // server to pick up any backend-side changes (e.g. session
      // invalidation timestamp).
      setStaff((cur) => cur.map((x) => (x._id === s._id ? { ...x, is_active: false, active: false } : x)));
      showToast('Staff deactivated', 'success');
      void reload();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Deactivate failed', 'error');
    } finally {
      setBusyRow(null);
    }
  };

  const copyResetPin = async () => {
    if (!resetPinFlash) return;
    try {
      await navigator.clipboard.writeText(resetPinFlash.pin);
      showToast('PIN copied', 'success');
    } catch {
      showToast('Could not copy — select the PIN and copy manually', 'error');
    }
  };

  return (
    <div>
      <div className="ch justify-between mb-4">
        <h2 className="m-0">Staff</h2>
        <button
          type="button"
          className="btn btn-success"
          onClick={onAdd}
        >
          + Add Staff
        </button>
      </div>

      {resetPinFlash && (
        <div className="notice danger mb-4">
          <div className="notice-ico">🔑</div>
          <div className="notice-body">
            <p>
              <strong>New PIN for {resetPinFlash.name}:</strong>{' '}
              <code className="font-mono text-base tracking-widest">{resetPinFlash.pin}</code>
            </p>
            <p className="text-xs text-dim">
              This PIN will not be shown again. Share it with your staff member now.
            </p>
            <div className="flex gap-2 mt-2">
              <button type="button" className="btn btn-success" onClick={() => { void copyResetPin(); }}>
                Copy PIN
              </button>
              <button type="button" className="btn" onClick={() => setResetPinFlash(null)}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="notice warn mb-4">
          <div className="notice-ico">⚠</div>
          <div className="notice-body"><p>{error}</p></div>
        </div>
      )}

      {loading ? (
        <p className="text-dim">Loading staff…</p>
      ) : staff.length === 0 ? (
        <div className="card">
          <div className="cb text-center py-8">
            <p className="text-dim text-sm">
              No staff yet. Tap <strong>Add Staff</strong> to invite your first team member.
            </p>
          </div>
        </div>
      ) : (
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Display name</th>
                <th>Staff ID</th>
                <th>Branches</th>
                <th>Role preset</th>
                <th>Permissions</th>
                <th>Active</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => {
                const branchIds = (s.branch_ids?.length ? s.branch_ids : s.branchIds) || [];
                const permCount = countTrue(s.permissions || {});
                const isBusy = busyRow === s._id;
                return (
                  <tr key={s._id}>
                    <td>
                      <div className="font-semibold">{s.display_name || s.name}</div>
                      {s.phone && <div className="text-xs text-dim">{s.phone}</div>}
                    </td>
                    <td><code className="text-xs">{s.staff_id}</code></td>
                    <td>
                      {branchIds.length === 0 ? (
                        <span className="text-xs text-dim italic">All branches</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {branchIds.map((bid) => (
                            <span
                              key={bid}
                              className="py-[0.15rem] px-2 text-xs rounded-full border border-rim bg-ink2"
                            >
                              {branchNameById[bid] || bid.slice(0, 6)}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>{PRESET_LABELS[s.role_preset] || s.role_preset}</td>
                    <td>
                      <span className="py-[0.15rem] px-2 text-xs rounded-full border border-rim bg-ink2">
                        {permCount} / 10
                      </span>
                    </td>
                    <td>
                      <label className="inline-flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={s.is_active}
                          onChange={() => { void onToggleActive(s); }}
                          disabled={isBusy}
                        />
                        <span className="text-xs text-dim">{s.is_active ? 'Active' : 'Inactive'}</span>
                      </label>
                    </td>
                    <td>
                      <div className="flex gap-1 flex-wrap">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => onEdit(s)}
                          disabled={isBusy}
                        >
                          Edit
                        </button>
                        {confirmResetPin === s._id ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-success btn-sm"
                              onClick={() => { void onResetPin(s); }}
                              disabled={isBusy}
                            >
                              {isBusy ? '…' : 'Confirm reset'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => setConfirmResetPin(null)}
                              disabled={isBusy}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setConfirmResetPin(s._id)}
                            disabled={isBusy}
                          >
                            Reset PIN
                          </button>
                        )}
                        {confirmDeactivate === s._id ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-del btn-sm"
                              onClick={() => { void onDeactivate(s); }}
                              disabled={isBusy}
                            >
                              {isBusy ? '…' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => setConfirmDeactivate(null)}
                              disabled={isBusy}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          s.is_active && (
                            <button
                              type="button"
                              className="btn btn-del btn-sm"
                              onClick={() => setConfirmDeactivate(s._id)}
                              disabled={isBusy}
                            >
                              Deactivate
                            </button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <StaffEditModal
        open={modalOpen}
        mode={modalMode}
        staff={editingStaff || undefined}
        branches={branchSummaries}
        onClose={() => setModalOpen(false)}
        onSaved={onSaved}
      />
    </div>
  );
}
