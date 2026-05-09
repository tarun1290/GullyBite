'use client';

// Owner-side modal for creating + editing staff members under the
// patched (PIN + role-preset) auth model.
//
// Shape:
//   - display_name (required)
//   - phone (optional, E.164)
//   - role_preset (one of cashier/kitchen/branch_manager/owner/custom)
//   - branch_ids (multi-select via toggleable chips)
//   - permissions (10 toggles in 2-col grid; read-only unless preset = 'custom')
//
// On create success the modal flips to a one-time PIN reveal panel —
// the backend returns generated_pin in the create response and never
// surfaces it again. The user must explicitly close the panel to
// dismiss the whole modal.

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../Toast';
import { createStaff, updateStaff } from '../../../api/staff';
import {
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  type BranchSummary,
  type Permissions,
  type RolePreset,
  type Staff,
} from '../../../types';

// 5×10 preset grid. Mirrors backend's permissionsFromPreset (Subagent
// B) — duplicated here so the modal can preview the role's effective
// permissions immediately, before the save round-trip. 'custom' is the
// "all toggles editable, no auto-fill" preset; we seed it with all
// false so the operator opts in deliberately.
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

interface FormState {
  display_name: string;
  phone: string;
  role_preset: RolePreset;
  branch_ids: string[];
  permissions: Permissions;
}

function emptyForm(): FormState {
  return {
    display_name: '',
    phone: '',
    role_preset: 'cashier',
    branch_ids: [],
    permissions: { ...PRESET_PERMISSIONS.cashier },
  };
}

function formFromStaff(s: Staff): FormState {
  return {
    display_name: s.display_name || s.name || '',
    phone: s.phone || '',
    role_preset: s.role_preset,
    branch_ids: Array.isArray(s.branch_ids) && s.branch_ids.length
      ? [...s.branch_ids]
      : Array.isArray(s.branchIds) ? [...s.branchIds] : [],
    permissions: { ...s.permissions },
  };
}

export interface StaffEditModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  staff?: Staff;
  branches: BranchSummary[];
  onClose: () => void;
  onSaved: (staff: Staff) => void;
}

export default function StaffEditModal({
  open,
  mode,
  staff,
  branches,
  onClose,
  onSaved,
}: StaffEditModalProps) {
  const { showToast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState<boolean>(false);
  // Post-create PIN reveal state. Non-null = show PIN panel. The user
  // must explicitly tap "Done" to dismiss; we don't auto-close so the
  // PIN can't be lost to a stray click outside the modal.
  const [revealedPin, setRevealedPin] = useState<string | null>(null);
  const [pinCopied, setPinCopied] = useState<boolean>(false);

  // Reset everything whenever the modal opens — guards against a
  // previous session's PIN leaking into the next add cycle.
  useEffect(() => {
    if (!open) return;
    setRevealedPin(null);
    setPinCopied(false);
    if (mode === 'edit' && staff) {
      setForm(formFromStaff(staff));
    } else {
      setForm(emptyForm());
    }
  }, [open, mode, staff]);

  const isCustom = form.role_preset === 'custom';

  // When the preset changes, snap the permissions grid to the preset's
  // canonical set. 'custom' keeps whatever toggles the user already had
  // so switching to custom from a preset doesn't wipe their choices.
  const onPresetChange = (preset: RolePreset) => {
    setForm((f) => ({
      ...f,
      role_preset: preset,
      permissions: preset === 'custom'
        ? f.permissions
        : { ...PRESET_PERMISSIONS[preset] },
    }));
  };

  const togglePermission = (key: keyof Permissions) => {
    if (!isCustom) return;
    setForm((f) => ({
      ...f,
      permissions: { ...f.permissions, [key]: !f.permissions[key] },
    }));
  };

  const toggleBranch = (id: string) => {
    setForm((f) => ({
      ...f,
      branch_ids: f.branch_ids.includes(id)
        ? f.branch_ids.filter((x) => x !== id)
        : [...f.branch_ids, id],
    }));
  };

  const setField = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  };

  const handleSave = async () => {
    const display_name = form.display_name.trim();
    if (!display_name) { showToast('Display name is required', 'error'); return; }
    const phone = form.phone.trim();
    if (phone && !E164.test(phone)) {
      showToast('Phone must be a valid international number (e.g. +919876543210)', 'error');
      return;
    }

    setSaving(true);
    try {
      if (mode === 'edit' && staff) {
        const res = await updateStaff(staff._id, {
          display_name,
          phone: phone || undefined,
          role_preset: form.role_preset,
          branch_ids: form.branch_ids,
          permissions: form.permissions,
        });
        showToast('Staff updated', 'success');
        onSaved(res.staff);
        onClose();
      } else {
        const res = await createStaff({
          display_name,
          phone: phone || undefined,
          role_preset: form.role_preset,
          branch_ids: form.branch_ids,
          permissions: form.permissions,
        });
        // Hand the new row up immediately so the parent's table
        // refreshes — the modal stays open on the PIN reveal panel.
        onSaved(res.staff);
        setRevealedPin(res.generated_pin);
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const copyPin = async () => {
    if (!revealedPin) return;
    try {
      await navigator.clipboard.writeText(revealedPin);
      setPinCopied(true);
      window.setTimeout(() => setPinCopied(false), 2000);
    } catch {
      showToast('Could not copy — select the PIN and copy manually', 'error');
    }
  };

  const onDonePinReveal = () => {
    setRevealedPin(null);
    setPinCopied(false);
    onClose();
  };

  // Branch chip list with a "no branches yet" empty state. Hidden when
  // the dashboard hasn't loaded any branches because chip toggles
  // would be confusing without options.
  const branchSection = useMemo(() => {
    if (branches.length === 0) {
      return (
        <div className="text-xs text-dim italic">
          No branches yet — add a branch under Restaurant → Branches first.
        </div>
      );
    }
    return (
      <div className="flex flex-wrap gap-2">
        {branches.map((b) => {
          const on = form.branch_ids.includes(b.id);
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => toggleBranch(b.id)}
              className={on
                ? 'py-1 px-3 text-xs rounded-full border bg-acc text-white border-acc cursor-pointer'
                : 'py-1 px-3 text-xs rounded-full border bg-transparent text-tx border-rim cursor-pointer'}
            >
              {b.name}
            </button>
          );
        })}
      </div>
    );
  }, [branches, form.branch_ids]);

  if (!open) return null;

  // ── PIN reveal panel ───────────────────────────────────────────
  // Shown after a successful create. The backend mints a 4-digit PIN
  // and returns it once; we surface it in a deliberately loud red box
  // and require an explicit "Done" tap to close.
  if (revealedPin) {
    return (
      <div
        className="fixed inset-0 bg-black/45 z-[999] flex items-center justify-center p-4"
        onClick={(e) => { if (e.target === e.currentTarget) { /* don't close on backdrop */ } }}
      >
        <div className="card w-[440px] max-w-[95vw] bg-surface">
          <div className="ch justify-between">
            <h3>Staff added — share this PIN now</h3>
          </div>
          <div className="cb">
            <div className="py-4 px-4 mb-4 bg-red-glow border-2 border-red-stroke rounded-lg text-center">
              <div className="text-xs text-dim uppercase tracking-wide mb-2">
                One-time PIN
              </div>
              <div className="font-mono text-4xl font-bold tracking-[0.4em] text-tx mb-3">
                {revealedPin}
              </div>
              <button
                type="button"
                onClick={() => { void copyPin(); }}
                className="btn btn-success"
              >
                {pinCopied ? 'Copied!' : 'Copy PIN'}
              </button>
            </div>
            <p className="text-sm text-tx mb-3">
              <strong>This PIN will not be shown again.</strong> Share it with
              your staff member now. They can sign in at <code>/staff/login</code>{' '}
              with the Restaurant ID, their Staff ID, and this PIN.
            </p>
            <p className="text-xs text-dim mb-4">
              If they lose it, you can mint a new one with &quot;Reset PIN&quot;
              on the staff list.
            </p>
            <button
              type="button"
              onClick={onDonePinReveal}
              className="btn btn-success w-full"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Edit form ─────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 bg-black/45 z-[999] flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-[520px] max-w-[95vw] bg-surface max-h-[90vh] overflow-y-auto">
        <div className="ch justify-between">
          <h3>{mode === 'edit' ? 'Edit staff' : 'Add staff'}</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="bg-none border-0 text-[1.3rem] cursor-pointer"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="cb">
          <label className="block text-xs text-tx mb-1">Display name</label>
          <input
            type="text"
            value={form.display_name}
            onChange={(e) => setField('display_name', e.target.value)}
            disabled={saving}
            className="border border-rim bg-surface rounded-lg px-3 py-2 w-full text-sm text-tx mb-3"
          />

          <label className="block text-xs text-tx mb-1">Phone (optional)</label>
          <input
            type="tel"
            value={form.phone}
            onChange={(e) => setField('phone', e.target.value)}
            disabled={saving}
            placeholder="+919876543210"
            className="border border-rim bg-surface rounded-lg px-3 py-2 w-full text-sm text-tx mb-3"
          />

          <label className="block text-xs text-tx mb-1">Role preset</label>
          <select
            value={form.role_preset}
            onChange={(e) => onPresetChange(e.target.value as RolePreset)}
            disabled={saving}
            className="border border-rim bg-surface rounded-lg px-3 py-2 w-full text-sm text-tx mb-4"
          >
            {ROLE_PRESET_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>

          <label className="block text-xs text-tx mb-2">Branches</label>
          <div className="mb-4">{branchSection}</div>

          <label className="block text-xs text-tx mb-2">
            Permissions
            {!isCustom && (
              <span className="text-dim font-normal ml-2">
                (auto-set by role — switch to Custom to edit)
              </span>
            )}
          </label>
          <div className={`grid grid-cols-2 gap-2 mb-4 ${isCustom ? '' : 'opacity-60'}`}>
            {PERMISSION_KEYS.map((key) => {
              const on = form.permissions[key];
              return (
                <label
                  key={key}
                  className={`flex items-center gap-2 py-2 px-3 border border-rim rounded-md text-xs ${isCustom ? 'cursor-pointer' : 'cursor-default'}`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => togglePermission(key)}
                    disabled={!isCustom || saving}
                  />
                  <span className="text-tx">{PERMISSION_LABELS[key]}</span>
                </label>
              );
            })}
          </div>

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="btn"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void handleSave(); }}
              disabled={saving}
              className="btn btn-success"
            >
              {saving ? 'Saving…' : mode === 'edit' ? 'Save' : 'Create staff'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
