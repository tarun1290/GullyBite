'use client';

import { useEffect, useState } from 'react';
import { useToast } from '../Toast';
import {
  createUser,
  updateUser,
  deleteUser,
  getBranchStaffLink,
  generateBranchStaffLink,
} from '../../api/restaurant';
import { createStaff, updateStaff } from '../../api/staff';
import {
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  type Permissions,
  type RolePreset,
} from '../../types';
import type { Branch, BranchStaffLink } from '../../types';

// Per-branch login-link row used by the post-creation success screen.
// `status` distinguishes a still-loading fetch from a resolved value or
// an outright fetch failure so each row can render its own state
// without blocking the others (Promise.allSettled wires this).
// `generating` covers the inline "Generate Link" click — branches that
// pre-date the auto-seed in routes/restaurant.js POST /branches carry
// no staff_access_token, so the operator clicks "Generate Link" inline
// instead of being redirected to the Branches tab.
interface BranchLink {
  branchId: string;
  branchName: string;
  status: 'loading' | 'ready' | 'generating' | 'error';
  url: string | null;
  errorMessage?: string;
}

// Widened to accept both legacy (kitchen/delivery/owner) and staff-app
// (cashier/kitchen/branch_manager/owner/custom + permissions blob)
// shapes. role_preset / permissions typed loosely (string / Record) so
// the modal's input contract stays permissive — the staff-app branch
// coerces to the strict types at the API call site via cast.
interface RestaurantUser {
  id: string;
  name?: string;
  display_name?: string;       // staff-app rows use this
  phone?: string;
  role?: string;               // 'kitchen'|'delivery'|'owner' (legacy) or 'staff'|'manager' (staff-app)
  role_preset?: string;        // staff-app only — 'cashier'|'kitchen'|'branch_manager'|'owner'|'custom'
  branch_ids?: string[];
  permissions?: Record<string, boolean>;  // staff-app 10-key blob
  is_active?: boolean;
  last_login_at?: string;
}

interface FormState {
  name: string;
  phone: string;
  pin: string;
  role: string;
  branchIds: string[];
}

interface StaffFormState {
  display_name: string;
  phone: string;
  role: 'staff' | 'manager';
  role_preset: RolePreset;
  branch_ids: string[];
  permissions: Permissions;
}

interface UserFormModalProps {
  open: boolean;
  mode: 'staff-app' | 'legacy';
  onClose: () => void;
  onSaved?: () => void;
  editing: RestaurantUser | null;
  branches: Branch[];
}

// Legacy ROLES — manager dropped per spec (staff-app is the
// authoritative path for manager-class roles now).
const ROLES: ReadonlyArray<readonly [string, string]> = [
  ['kitchen', '👨‍🍳 Kitchen'],
  ['delivery', '🚴 Delivery'],
];

// 5×10 preset grid. Mirrors backend's permissionsFromPreset — duplicated
// here so the modal can preview the role's effective permissions
// immediately, before the save round-trip. 'custom' is the "all toggles
// editable, no auto-fill" preset; we seed it with all false so the
// operator opts in deliberately.
const PRESET_PERMISSIONS: Record<RolePreset, Permissions> = {
  cashier: {
    view_orders: true,
    accept_orders: true,
    reject_orders: false,
    mark_ready: true,
    manage_menu: false,
    manage_stock: false,
    view_reports: false,
    manage_settings: false,
    refund_orders: false,
    view_customer_details: true,
  },
  kitchen: {
    view_orders: true,
    accept_orders: false,
    reject_orders: false,
    mark_ready: true,
    manage_menu: false,
    manage_stock: true,
    view_reports: false,
    manage_settings: false,
    refund_orders: false,
    view_customer_details: false,
  },
  branch_manager: {
    view_orders: true,
    accept_orders: true,
    reject_orders: true,
    mark_ready: true,
    manage_menu: true,
    manage_stock: true,
    view_reports: true,
    manage_settings: false,
    refund_orders: true,
    view_customer_details: true,
  },
  owner: {
    view_orders: true,
    accept_orders: true,
    reject_orders: true,
    mark_ready: true,
    manage_menu: true,
    manage_stock: true,
    view_reports: true,
    manage_settings: true,
    refund_orders: true,
    view_customer_details: true,
  },
  custom: {
    view_orders: false,
    accept_orders: false,
    reject_orders: false,
    mark_ready: false,
    manage_menu: false,
    manage_stock: false,
    view_reports: false,
    manage_settings: false,
    refund_orders: false,
    view_customer_details: false,
  },
};

const ROLE_PRESET_OPTIONS: ReadonlyArray<readonly [RolePreset, string]> = [
  ['cashier', 'Cashier'],
  ['kitchen', 'Kitchen'],
  ['branch_manager', 'Branch Manager'],
  ['owner', 'Owner'],
  ['custom', 'Custom'],
];

// Loose E.164: plus sign + 8-15 digits. Matches the backend regex used
// by the wallet / customer modules. Optional field, so empty is OK.
const E164 = /^\+?[1-9]\d{7,14}$/;

function emptyForm(): FormState {
  return { name: '', phone: '', pin: '', role: 'kitchen', branchIds: [] };
}

function emptyStaffForm(): StaffFormState {
  return {
    display_name: '',
    phone: '',
    role: 'staff',
    role_preset: 'cashier',
    branch_ids: [],
    permissions: { ...PRESET_PERMISSIONS.cashier },
  };
}

function staffFormFromUser(u: RestaurantUser): StaffFormState {
  return {
    display_name: u.display_name || u.name || '',
    phone: u.phone || '',
    role: (u.role === 'manager' ? 'manager' : 'staff'),
    role_preset: (u.role_preset as RolePreset) || 'cashier',
    branch_ids: Array.isArray(u.branch_ids) ? [...u.branch_ids] : [],
    permissions: { ...((u.permissions as Permissions) || PRESET_PERMISSIONS.cashier) },
  };
}

export default function UserFormModal({ open, mode, onClose, onSaved, editing, branches }: UserFormModalProps) {
  const { showToast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [staffForm, setStaffForm] = useState<StaffFormState>(emptyStaffForm());
  const [saving, setSaving] = useState<boolean>(false);
  // Post-create success screen state. `created` non-null means the
  // staff row landed and we're now showing the login-link handoff
  // surface inside the same modal (not a separate dialog). Reset on
  // every open() so a previous success screen doesn't leak into the
  // next add session.
  const [created, setCreated] = useState<{ name: string; role: string; branchIds: string[] } | null>(null);
  const [branchLinks, setBranchLinks] = useState<BranchLink[]>([]);
  const [copiedBranchId, setCopiedBranchId] = useState<string | null>(null);
  // staff-app post-create PIN reveal. Non-null = show PIN panel. The
  // user must explicitly tap "Done" to dismiss; we don't auto-close so
  // the PIN can't be lost to a stray click outside the modal.
  const [generatedPin, setGeneratedPin] = useState<string | null>(null);
  const [pinCopied, setPinCopied] = useState<boolean>(false);
  // Inline destructive-confirm state for the legacy edit-mode "Delete
  // Account" button. Kept in the modal (not the parent UsersSection) so
  // the confirm copy can interpolate the staff name and the delete
  // result can fire onSaved + onClose in one place.
  const [deleteConfirming, setDeleteConfirming] = useState<boolean>(false);
  const [deleteBusy, setDeleteBusy] = useState<boolean>(false);

  useEffect(() => {
    if (!open) {
      // Clear success state when the modal fully closes so a re-open
      // (Add Member again) starts on the form.
      setCreated(null);
      setBranchLinks([]);
      setCopiedBranchId(null);
      setGeneratedPin(null);
      setPinCopied(false);
      setDeleteConfirming(false);
      setDeleteBusy(false);
      return;
    }
    if (mode === 'staff-app') {
      if (editing) {
        setStaffForm(staffFormFromUser(editing));
      } else {
        setStaffForm(emptyStaffForm());
      }
    } else {
      if (editing) {
        setForm({
          name: editing.name || '',
          phone: editing.phone || '',
          pin: '',
          role: editing.role || 'kitchen',
          branchIds: Array.isArray(editing.branch_ids) ? [...editing.branch_ids] : [],
        });
      } else {
        setForm(emptyForm());
      }
    }
  }, [open, mode, editing]);

  // Edit-mode parallel of the post-create branch-link fetcher below.
  // Fires when an existing staff member is opened in the modal so the
  // operator can copy/regen each assigned branch's login URL inline,
  // without bouncing back to the post-create success screen.
  // Sources branchIds from editing.branch_ids (the persisted assignment)
  // not form.branchIds — the latter mutates as the user toggles chips
  // before saving, and the link list should reflect what's actually
  // assigned today, not the in-flight edit.
  // Only runs in legacy mode — staff-app rows don't surface per-branch
  // login URLs (they sign in via store_slug + staff_id + PIN, no token).
  useEffect(() => {
    if (!open || !editing || mode !== 'legacy') return;
    const assigned = Array.isArray(editing.branch_ids) ? editing.branch_ids : [];
    if (assigned.length === 0) {
      setBranchLinks([]);
      return;
    }
    const initial: BranchLink[] = assigned.map((bid) => {
      const b = branches.find((x) => x.id === bid);
      return {
        branchId: bid,
        branchName: b?.name || `Branch ${bid.slice(0, 8)}…`,
        status: 'loading',
        url: null,
      };
    });
    setBranchLinks(initial);

    let cancelled = false;
    Promise.allSettled(
      assigned.map((bid) => getBranchStaffLink(bid)),
    ).then((results) => {
      if (cancelled) return;
      setBranchLinks((prev) => prev.map((row, idx) => {
        const r: PromiseSettledResult<BranchStaffLink> | undefined = results[idx];
        if (!r) return row;
        if (r.status === 'fulfilled') {
          const link = r.value;
          return {
            ...row,
            status: 'ready',
            url: link?.staff_login_url || null,
            errorMessage: link?.staff_login_url ? undefined : 'No link generated yet for this branch',
          };
        }
        const reason = (r.reason as { message?: string })?.message || 'Failed to load';
        return { ...row, status: 'error', url: null, errorMessage: reason };
      }));
    });
    return () => { cancelled = true; };
  }, [open, editing, branches, mode]);

  // Fetch per-branch staff-login URLs for the just-created member.
  // Promise.allSettled so a single 404/500 on one branch doesn't keep
  // the rest from rendering. Updates a per-row status field rather
  // than a single "loading" boolean so each row independently flips
  // ready/error as its fetch resolves.
  useEffect(() => {
    if (!created || created.branchIds.length === 0) return;
    const initial: BranchLink[] = created.branchIds.map((bid) => {
      const b = branches.find((x) => x.id === bid);
      return {
        branchId: bid,
        branchName: b?.name || `Branch ${bid.slice(0, 8)}…`,
        status: 'loading',
        url: null,
      };
    });
    setBranchLinks(initial);

    let cancelled = false;
    Promise.allSettled(
      created.branchIds.map((bid) => getBranchStaffLink(bid)),
    ).then((results) => {
      if (cancelled) return;
      setBranchLinks((prev) => prev.map((row, idx) => {
        const r: PromiseSettledResult<BranchStaffLink> | undefined = results[idx];
        if (!r) return row;
        if (r.status === 'fulfilled') {
          const link = r.value;
          return {
            ...row,
            status: 'ready',
            url: link?.staff_login_url || null,
            errorMessage: link?.staff_login_url ? undefined : 'No link generated yet for this branch',
          };
        }
        const reason = (r.reason as { message?: string })?.message || 'Failed to load';
        return { ...row, status: 'error', url: null, errorMessage: reason };
      }));
    });
    return () => { cancelled = true; };
  }, [created, branches]);

  const copyLink = async (branchId: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedBranchId(branchId);
      setTimeout(() => {
        setCopiedBranchId((cur) => (cur === branchId ? null : cur));
      }, 2000);
    } catch {
      showToast('Could not copy — select the link and copy manually', 'error');
    }
  };

  const copyPin = async () => {
    if (!generatedPin) return;
    try {
      await navigator.clipboard.writeText(generatedPin);
      setPinCopied(true);
      window.setTimeout(() => setPinCopied(false), 2000);
    } catch {
      showToast('Could not copy — select the PIN and copy manually', 'error');
    }
  };

  // Inline regeneration for branches that came back null on the initial
  // GET (typically pre-auto-seed branches that never had a token
  // generated). POST /staff-link/generate returns the freshly built URL
  // in the response, so no follow-up GET is needed — we apply the
  // returned shape directly to the row.
  const regenerateLink = async (branchId: string) => {
    setBranchLinks((prev) => prev.map((r) =>
      r.branchId === branchId ? { ...r, status: 'generating', errorMessage: undefined } : r,
    ));
    try {
      const link = await generateBranchStaffLink(branchId);
      setBranchLinks((prev) => prev.map((r) =>
        r.branchId === branchId
          ? {
              ...r,
              status: 'ready',
              url: link?.staff_login_url || null,
              errorMessage: link?.staff_login_url ? undefined : 'Link generated but URL is empty — check FRONTEND_URL on the backend',
            }
          : r,
      ));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const reason = e?.response?.data?.error || e?.message || 'Generate failed';
      setBranchLinks((prev) => prev.map((r) =>
        r.branchId === branchId
          ? { ...r, status: 'error', url: null, errorMessage: reason }
          : r,
      ));
    }
  };

  const isEdit = !!editing;
  const isCustomPreset = staffForm.role_preset === 'custom';

  // Single-row renderer shared by the post-create success screen and the
  // edit-mode "Branch Login URLs" section so the four status branches
  // (loading / generating / ready+url / ready+empty / error) stay in one
  // place.
  const renderBranchLinkRow = (row: BranchLink) => (
    <div
      key={row.branchId}
      className="py-2 px-3 border-b border-bdr text-sm"
    >
      <div className="font-semibold mb-1">{row.branchName}</div>
      {row.status === 'loading' && (
        <div className="text-xs text-dim">Loading…</div>
      )}
      {row.status === 'generating' && (
        <div className="text-xs text-dim">Generating…</div>
      )}
      {row.status === 'ready' && row.url && (
        <div className="flex gap-1.5 items-center">
          <input
            value={row.url}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 font-mono text-xs bg-ink2 border border-rim rounded-sm py-1 px-1.5 text-dim"
          />
          <button
            type="button"
            onClick={() => copyLink(row.branchId, row.url || '')}
            className="bg-transparent border border-bdr text-dim text-xs py-1 px-2 rounded-sm cursor-pointer shrink-0"
          >
            {copiedBranchId === row.branchId ? 'Copied!' : 'Copy'}
          </button>
        </div>
      )}
      {row.status === 'ready' && !row.url && (
        <div className="flex flex-col gap-1">
          <div className="text-xs text-amber-900">
            ⚠ No login link yet for this branch.
          </div>
          <button
            type="button"
            onClick={() => regenerateLink(row.branchId)}
            className="self-start btn-g btn-sm"
          >
            Generate Link
          </button>
        </div>
      )}
      {row.status === 'error' && (
        <div className="flex flex-col gap-1">
          <div className="text-xs text-red">
            {row.errorMessage || 'Failed to load'}
          </div>
          <button
            type="button"
            onClick={() => regenerateLink(row.branchId)}
            className="self-start btn-g btn-sm"
          >
            Generate Link
          </button>
        </div>
      )}
    </div>
  );

  const toggleBranch = (id: string) => {
    setForm((f) => ({
      ...f,
      branchIds: f.branchIds.includes(id)
        ? f.branchIds.filter((x) => x !== id)
        : [...f.branchIds, id],
    }));
  };

  const toggleStaffBranch = (id: string) => {
    setStaffForm((f) => ({
      ...f,
      branch_ids: f.branch_ids.includes(id)
        ? f.branch_ids.filter((x) => x !== id)
        : [...f.branch_ids, id],
    }));
  };

  // When the preset changes, snap the permissions grid to the preset's
  // canonical set. 'custom' keeps whatever toggles the user already had
  // so switching to custom from a preset doesn't wipe their choices.
  const onPresetChange = (preset: RolePreset) => {
    setStaffForm((f) => ({
      ...f,
      role_preset: preset,
      permissions: preset === 'custom'
        ? f.permissions
        : { ...PRESET_PERMISSIONS[preset] },
    }));
  };

  const togglePermission = (key: keyof Permissions) => {
    if (!isCustomPreset) return;
    setStaffForm((f) => ({
      ...f,
      permissions: { ...f.permissions, [key]: !f.permissions[key] },
    }));
  };

  // Soft-delete via DELETE /api/restaurant/users/:id (flips is_active=false).
  // Legacy mode only — staff-app rows soft-delete via the row kebab's
  // Deactivate action (deactivateStaff in api/staff.ts).
  const handleDeleteAccount = async () => {
    if (!editing) return;
    setDeleteBusy(true);
    try {
      await deleteUser(editing.id);
      showToast(`${editing.name || 'Staff'} deactivated`, 'success');
      if (onSaved) onSaved();
      onClose();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
    } finally {
      setDeleteBusy(false);
      setDeleteConfirming(false);
    }
  };

  const handleSaveLegacy = async () => {
    const name = form.name.trim();
    if (!name) { showToast('Name is required', 'error'); return; }
    setSaving(true);
    try {
      if (isEdit && editing) {
        await updateUser(editing.id, { name, role: form.role, branchIds: form.branchIds });
        showToast('User updated', 'success');
        if (onSaved) onSaved();
        onClose();
      } else {
        const phone = form.phone.trim();
        const pin = form.pin.trim();
        if (!phone || !pin) { setSaving(false); showToast('Phone and PIN are required', 'error'); return; }
        await createUser({ name, phone, pin, role: form.role, branchIds: form.branchIds });
        showToast('User created', 'success');
        // Refetch the parent's user list immediately so the new row
        // shows up — the modal stays open on the success screen so the
        // owner can copy login URLs before dismissing.
        if (onSaved) onSaved();
        setCreated({
          name,
          role: form.role,
          branchIds: [...form.branchIds],
        });
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveStaffApp = async () => {
    const display_name = staffForm.display_name.trim();
    if (!display_name) { showToast('Display name is required', 'error'); return; }
    const phone = staffForm.phone.trim();
    if (phone && !E164.test(phone)) {
      showToast('Phone must be a valid international number (e.g. +919876543210)', 'error');
      return;
    }
    setSaving(true);
    try {
      if (isEdit && editing) {
        const payload = {
          display_name,
          phone: phone || undefined,
          role_preset: staffForm.role_preset,
          branch_ids: staffForm.branch_ids,
          permissions: staffForm.permissions,
        } as const;
        // role is forwarded; backend may default to 'staff' if it ignores this field
        await updateStaff(
          editing.id,
          { ...payload, role: staffForm.role } as Parameters<typeof updateStaff>[1] & { role: string },
        );
        showToast('Staff updated', 'success');
        if (onSaved) onSaved();
        onClose();
      } else {
        const payload = {
          display_name,
          phone: phone || undefined,
          role_preset: staffForm.role_preset,
          branch_ids: staffForm.branch_ids,
          permissions: staffForm.permissions,
        } as const;
        // role is forwarded; backend may default to 'staff' if it ignores this field
        const res = await createStaff(
          { ...payload, role: staffForm.role } as Parameters<typeof createStaff>[0] & { role: string },
        );
        if (onSaved) onSaved();
        setGeneratedPin(res.generated_pin);
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = mode === 'staff-app' ? handleSaveStaffApp : handleSaveLegacy;

  if (!open) return null;

  // ── staff-app post-create PIN reveal panel ─────────────────────
  // Shown after a successful staff-app create. The backend mints a
  // 4-digit PIN and returns it once; we surface it in a deliberately
  // loud panel and require an explicit "Done" tap to close.
  if (mode === 'staff-app' && generatedPin) {
    return (
      <div
        className="fixed inset-0 bg-black/45 z-999 flex items-center justify-center p-4"
      >
        <div className="card w-[440px] max-w-[95vw] bg-surface">
          <div className="ch justify-between">
            <h3>Staff added — share this PIN now</h3>
          </div>
          <div className="cb">
            <div className="mb-3 py-2.5 px-3 bg-green-50 border border-green-200 rounded-lg">
              <div className="font-bold text-green-700 text-md">
                ✓ {staffForm.display_name}
              </div>
            </div>
            <div className="py-4 px-4 mb-4 bg-green-50 border border-green-200 rounded-lg text-center">
              <div className="text-xs text-dim uppercase tracking-wide mb-2">
                🔑 One-time PIN
              </div>
              <div className="font-mono text-4xl font-bold tracking-[0.4em] text-tx mb-3">
                {generatedPin}
              </div>
              <button
                type="button"
                onClick={() => { void copyPin(); }}
                className="btn-p btn-sm"
              >
                {pinCopied ? 'Copied!' : 'Copy PIN'}
              </button>
            </div>
            <p className="text-sm text-tx mb-3">
              <strong>This PIN will not be shown again.</strong> Share it with
              your staff member now.
            </p>
            <div className="flex gap-3 mt-3">
              <button type="button" className="btn-p" onClick={onClose}>Done</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black/45 z-999 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Success screen renders narrow content (PIN, link list); the
          form variants need room for the two-column grid. Container
          width is conditioned on the rendered branch. */}
      <div className={`card bg-surface ${created ? 'w-[440px] max-w-[95vw]' : 'w-full max-w-3xl mx-auto'}`}>
        <div className="ch justify-between">
          <h3>
            {mode === 'legacy' && created
              ? 'Team member added!'
              : (isEdit ? 'Edit Team Member' : 'Add Team Member')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="bg-none border-0 text-xl cursor-pointer"
          >
            ×
          </button>
        </div>
        <div className="cb">
          {mode === 'staff-app' ? (
            // ── staff-app form (create / edit) ─────────────────────
            // Two-column grid on md+: identity/role fields stack in the
            // left column, branches occupy the right column, the
            // permissions grid + footer span both via md:col-span-2.
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="fg mb-3">
                  <label>Display Name ★</label>
                  <input
                    value={staffForm.display_name}
                    onChange={(e) => setStaffForm((f) => ({ ...f, display_name: e.target.value }))}
                    placeholder="Rahul Sharma"
                  />
                </div>
                <div className="fg mb-3">
                  <label>Phone <small className="text-dim">(optional)</small></label>
                  <input
                    type="tel"
                    value={staffForm.phone}
                    onChange={(e) => setStaffForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="+919876543210"
                  />
                </div>
                <div className="fg mb-3">
                  <label>Role ★</label>
                  <select
                    value={staffForm.role}
                    onChange={(e) => setStaffForm((f) => ({ ...f, role: e.target.value as 'staff' | 'manager' }))}
                    className="p-2 border border-rim rounded-r w-full"
                  >
                    <option value="staff">🧑‍🍳 Staff (POS)</option>
                    <option value="manager">📋 Manager</option>
                  </select>
                </div>
                <div className="fg mb-3">
                  <label>Role Preset ★</label>
                  <select
                    value={staffForm.role_preset}
                    onChange={(e) => onPresetChange(e.target.value as RolePreset)}
                    className="p-2 border border-rim rounded-r w-full"
                  >
                    {ROLE_PRESET_OPTIONS.map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="fg mb-3">
                <label>Branches <small className="text-dim">(leave empty for all)</small></label>
                {(branches || []).length > 0 ? (
                  <div className="flex flex-wrap gap-3 mt-2">
                    {(branches || []).map((b) => {
                      const on = staffForm.branch_ids.includes(b.id);
                      return (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => toggleStaffBranch(b.id)}
                          aria-pressed={on}
                          className={on ? 'chip on' : 'chip'}
                        >
                          {b.name}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <span className="text-sm text-dim">No branches yet.</span>
                )}
              </div>
              <div className="fg mb-3 md:col-span-2">
                <label>
                  Permissions
                  {!isCustomPreset && (
                    <small className="text-dim font-normal ml-2">
                      (auto-set by preset — switch to Custom to edit)
                    </small>
                  )}
                </label>
                <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 mt-2 ${isCustomPreset ? '' : 'opacity-60'}`}>
                  {PERMISSION_KEYS.map((key) => {
                    const on = staffForm.permissions[key];
                    return (
                      <label
                        key={key}
                        className={`flex items-center gap-2 py-2 px-3 border border-rim rounded-md text-xs ${isCustomPreset ? 'cursor-pointer' : 'cursor-default'}`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => togglePermission(key)}
                          disabled={!isCustomPreset || saving}
                        />
                        <span className="text-tx">{PERMISSION_LABELS[key]}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center gap-3 mt-4 md:col-span-2 justify-end">
                <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={saving}>
                  Cancel
                </button>
                <button type="button" className="btn-p btn-sm" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Member')}
                </button>
              </div>
            </div>
          ) : created ? (
            // ── legacy post-creation success screen ────────────────
            <>
              <div className="mb-3 py-2.5 px-3 bg-green-50 border border-green-200 rounded-lg">
                <div className="font-bold text-green-700 text-md">
                  ✓ {created.name}
                </div>
                <div className="text-sm text-green-800 capitalize">
                  {created.role}
                </div>
              </div>

              <div className="fg mb-3">
                <label>Branch Login URLs</label>
                {created.branchIds.length === 0 ? (
                  <div className="mt-1 py-2 px-3 bg-ink2 border border-rim rounded-md text-sm text-dim">
                    Share the branch login URL with your team member from the Branches tab.
                  </div>
                ) : (
                  <div className="mt-1 max-h-[220px] overflow-y-auto border border-rim rounded-md">
                    {branchLinks.map(renderBranchLinkRow)}
                  </div>
                )}
              </div>

              <div className="flex gap-3 mt-3">
                <button type="button" className="btn-p" onClick={onClose}>Done</button>
              </div>
            </>
          ) : (
            // ── legacy form (create / edit) ────────────────────────
            // Two-column grid: identity fields left, branch assignment
            // + edit-mode login URL list right, footer spans both.
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="fg mb-3">
                  <label>Name ★</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Rahul Sharma"
                  />
                </div>
                <div className="fg mb-3">
                  <label>Phone {isEdit ? '' : '★'}</label>
                  <input
                    value={form.phone}
                    onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="+91 98765 43210"
                    disabled={isEdit}
                    className={isEdit ? 'opacity-60' : ''}
                  />
                  {isEdit && (
                    <div className="text-xs text-dim mt-1">
                      Phone is locked after creation.
                    </div>
                  )}
                </div>
                {!isEdit && (
                  <div className="fg mb-3">
                    <label>PIN (4-6 digits) ★</label>
                    <input
                      type="password"
                      maxLength={6}
                      value={form.pin}
                      onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value }))}
                      placeholder="1234"
                    />
                  </div>
                )}
                <div className="fg mb-3">
                  <label>Role ★</label>
                  <select
                    value={form.role}
                    onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                    className="p-2 border border-rim rounded-r w-full"
                  >
                    {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <div className="fg mb-3">
                  <label>Branches <small className="text-dim">(leave empty for all)</small></label>
                  {(branches || []).length > 0 ? (
                    <div className="flex flex-wrap gap-3 mt-2">
                      {(branches || []).map((b) => {
                        const on = form.branchIds.includes(b.id);
                        return (
                          <button
                            key={b.id}
                            type="button"
                            onClick={() => toggleBranch(b.id)}
                            aria-pressed={on}
                            className={on ? 'chip on' : 'chip'}
                          >
                            {b.name}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="text-sm text-dim">No branches yet.</span>
                  )}
                </div>
                {isEdit && Array.isArray(editing?.branch_ids) && editing.branch_ids.length > 0 && (
                  <div className="fg mb-3">
                    <label>Branch Login URLs</label>
                    <div className="mt-1 max-h-[220px] overflow-y-auto border border-rim rounded-md">
                      {branchLinks.map(renderBranchLinkRow)}
                    </div>
                  </div>
                )}
              </div>
              {/* Action row spans both columns. Delete Account is
                  pinned left via mr-auto; Save/Cancel sit at the right
                  edge thanks to justify-end. */}
              {!deleteConfirming && (
                <div className="flex items-center gap-3 mt-4 md:col-span-2 justify-end">
                  {isEdit && (
                    <button
                      type="button"
                      className="btn-del btn-sm mr-auto"
                      onClick={() => setDeleteConfirming(true)}
                      disabled={saving}
                    >
                      Delete Account
                    </button>
                  )}
                  <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={saving}>
                    Cancel
                  </button>
                  <button type="button" className="btn-p btn-sm" onClick={handleSave} disabled={saving}>
                    {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Member')}
                  </button>
                </div>
              )}
              {isEdit && deleteConfirming && (
                <div className="mt-4 md:col-span-2">
                  <div className="text-sm text-red">
                    This is permanent and cannot be undone. Delete {editing?.name || 'this staff member'}?
                  </div>
                  <div className="flex items-center gap-3 mt-2 justify-end">
                    <button
                      type="button"
                      className="btn-g btn-sm"
                      onClick={() => setDeleteConfirming(false)}
                      disabled={deleteBusy}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn-del btn-sm"
                      onClick={handleDeleteAccount}
                      disabled={deleteBusy}
                    >
                      {deleteBusy ? '…' : 'Confirm Delete'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export type { RestaurantUser };
