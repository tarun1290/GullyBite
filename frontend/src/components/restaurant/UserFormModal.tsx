'use client';

import { useEffect, useState } from 'react';
import { useToast } from '../Toast';
import {
  createUser,
  updateUser,
  getBranchStaffLink,
  generateBranchStaffLink,
  deleteStaffHard,
} from '../../api/restaurant';
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

interface RestaurantUser {
  id: string;
  name?: string;
  phone?: string;
  role?: string;
  branch_ids?: string[];
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

interface UserFormModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  editing: RestaurantUser | null;
  branches: Branch[];
}

const ROLES: ReadonlyArray<readonly [string, string]> = [
  ['manager', '📋 Manager'],
  ['kitchen', '👨‍🍳 Kitchen'],
  ['delivery', '🚴 Delivery'],
];

function emptyForm(): FormState {
  return { name: '', phone: '', pin: '', role: 'manager', branchIds: [] };
}

export default function UserFormModal({ open, onClose, onSaved, editing, branches }: UserFormModalProps) {
  const { showToast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState<boolean>(false);
  // Post-create success screen state. `created` non-null means the
  // staff row landed and we're now showing the login-link handoff
  // surface inside the same modal (not a separate dialog). Reset on
  // every open() so a previous success screen doesn't leak into the
  // next add session.
  const [created, setCreated] = useState<{ name: string; role: string; branchIds: string[] } | null>(null);
  const [branchLinks, setBranchLinks] = useState<BranchLink[]>([]);
  const [copiedBranchId, setCopiedBranchId] = useState<string | null>(null);
  // Inline destructive-confirm state for the edit-mode "Delete Account"
  // button. Kept in the modal (not the parent UsersSection) so the
  // confirm copy can interpolate the staff name and the delete result
  // can fire onSaved + onClose in one place.
  const [deleteConfirming, setDeleteConfirming] = useState<boolean>(false);
  const [deleteBusy, setDeleteBusy] = useState<boolean>(false);

  useEffect(() => {
    if (!open) {
      // Clear success state when the modal fully closes so a re-open
      // (Add Member again) starts on the form.
      setCreated(null);
      setBranchLinks([]);
      setCopiedBranchId(null);
      setDeleteConfirming(false);
      setDeleteBusy(false);
      return;
    }
    if (editing) {
      setForm({
        name: editing.name || '',
        phone: editing.phone || '',
        pin: '',
        role: editing.role || 'manager',
        branchIds: Array.isArray(editing.branch_ids) ? [...editing.branch_ids] : [],
      });
    } else {
      setForm(emptyForm());
    }
  }, [open, editing]);

  // Edit-mode parallel of the post-create branch-link fetcher below.
  // Fires when an existing staff member is opened in the modal so the
  // operator can copy/regen each assigned branch's login URL inline,
  // without bouncing back to the post-create success screen.
  // Sources branchIds from editing.branch_ids (the persisted assignment)
  // not form.branchIds — the latter mutates as the user toggles chips
  // before saving, and the link list should reflect what's actually
  // assigned today, not the in-flight edit.
  useEffect(() => {
    if (!open || !editing) return;
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
  }, [open, editing, branches]);

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

  // Single-row renderer shared by the post-create success screen and the
  // edit-mode "Branch Login URLs" section so the four status branches
  // (loading / generating / ready+url / ready+empty / error) stay in one
  // place.
  const renderBranchLinkRow = (row: BranchLink) => (
    <div
      key={row.branchId}
      className="py-[0.55rem] px-[0.7rem] border-b border-bdr text-[0.8rem]"
    >
      <div className="font-semibold mb-[0.2rem]">{row.branchName}</div>
      {row.status === 'loading' && (
        <div className="text-[0.74rem] text-dim">Loading…</div>
      )}
      {row.status === 'generating' && (
        <div className="text-[0.74rem] text-dim">Generating…</div>
      )}
      {row.status === 'ready' && row.url && (
        <div className="flex gap-[0.4rem] items-center">
          <input
            value={row.url}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 font-mono text-[0.74rem] bg-ink2 border border-rim rounded-sm py-1 px-[0.4rem] text-dim"
          />
          <button
            type="button"
            onClick={() => copyLink(row.branchId, row.url || '')}
            className="bg-transparent border border-bdr text-dim text-[0.7rem] py-[0.2rem] px-2 rounded-sm cursor-pointer shrink-0"
          >
            {copiedBranchId === row.branchId ? 'Copied!' : 'Copy'}
          </button>
        </div>
      )}
      {row.status === 'ready' && !row.url && (
        <div className="flex flex-col gap-[0.3rem]">
          <div className="text-[0.72rem] text-[#92400e]">
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
        <div className="flex flex-col gap-[0.3rem]">
          <div className="text-[0.72rem] text-red">
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

  // Hits DELETE /api/restaurant/staff/:staffId on the backend, which
  // hard-deletes the row and writes an activity log with action
  // 'staff_deleted'. Distinct from the row-level Deactivate in
  // UsersSection (soft-delete via /users/:id flipping is_active).
  const handleDeleteAccount = async () => {
    if (!editing) return;
    setDeleteBusy(true);
    try {
      await deleteStaffHard(editing.id);
      showToast(`${editing.name || 'Staff'} deleted`, 'success');
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

  const handleSave = async () => {
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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/45 z-999 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-[440px] max-w-[95vw] bg-surface">
        <div className="ch justify-between">
          <h3>{created ? 'Team member added!' : (isEdit ? 'Edit Team Member' : 'Add Team Member')}</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="bg-none border-0 text-[1.3rem] cursor-pointer"
          >
            ×
          </button>
        </div>
        <div className="cb">
          {created ? (
            // ── Post-creation success screen ───────────────────────
            <>
              <div className="mb-[0.8rem] py-[0.6rem] px-3 bg-[#f0fdf4] border border-[#bbf7d0] rounded-lg">
                <div className="font-bold text-[#15803d] text-[0.92rem]">
                  ✓ {created.name}
                </div>
                <div className="text-[0.78rem] text-[#166534] capitalize">
                  {created.role}
                </div>
              </div>

              <div className="fg mb-[0.7rem]">
                <label>Branch Login URLs</label>
                {created.branchIds.length === 0 ? (
                  <div className="mt-[0.3rem] py-[0.55rem] px-[0.7rem] bg-ink2 border border-rim rounded-md text-[0.78rem] text-dim">
                    Share the branch login URL with your team member from the Branches tab.
                  </div>
                ) : (
                  <div className="mt-[0.3rem] max-h-[220px] overflow-y-auto border border-rim rounded-md">
                    {branchLinks.map(renderBranchLinkRow)}
                  </div>
                )}
              </div>

              <div className="flex gap-3 mt-[0.8rem]">
                <button type="button" className="btn-p" onClick={onClose}>Done</button>
              </div>
            </>
          ) : (
            // ── Form (create / edit) ───────────────────────────────
            <>
              <div className="fg mb-[0.7rem]">
                <label>Name ★</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Rahul Sharma"
                />
              </div>
              <div className="fg mb-[0.7rem]">
                <label>Phone {isEdit ? '' : '★'}</label>
                <input
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="+91 98765 43210"
                  disabled={isEdit}
                  className={isEdit ? 'opacity-60' : ''}
                />
                {isEdit && (
                  <div className="text-[0.7rem] text-dim mt-[0.2rem]">
                    Phone is locked after creation.
                  </div>
                )}
              </div>
              {!isEdit && (
                <div className="fg mb-[0.7rem]">
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
              <div className="fg mb-[0.7rem]">
                <label>Role ★</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  className="p-2 border border-rim rounded-r w-full"
                >
                  {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="fg mb-[0.7rem]">
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
                  <span className="text-[0.78rem] text-dim">No branches yet.</span>
                )}
              </div>
              {isEdit && Array.isArray(editing?.branch_ids) && editing.branch_ids.length > 0 && (
                <div className="fg mb-[0.7rem]">
                  <label>Branch Login URLs</label>
                  <div className="mt-[0.3rem] max-h-[220px] overflow-y-auto border border-rim rounded-md">
                    {branchLinks.map(renderBranchLinkRow)}
                  </div>
                </div>
              )}
              <div className="flex gap-3 mt-[0.8rem]">
                <button type="button" className="btn-p" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Member')}
                </button>
                <button type="button" className="btn-g" onClick={onClose} disabled={saving}>
                  Cancel
                </button>
              </div>
              {isEdit && (
                <div className="mt-[1.2rem] pt-[0.8rem] border-t border-rim">
                  {deleteConfirming ? (
                    <div className="flex flex-col gap-[0.5rem]">
                      <div className="text-[0.82rem] text-red">
                        This is permanent and cannot be undone. Delete {editing?.name || 'this staff member'}?
                      </div>
                      <div className="flex gap-3">
                        <button
                          type="button"
                          className="btn-del btn-sm"
                          onClick={handleDeleteAccount}
                          disabled={deleteBusy}
                        >
                          {deleteBusy ? '…' : 'Confirm Delete'}
                        </button>
                        <button
                          type="button"
                          className="btn-g btn-sm"
                          onClick={() => setDeleteConfirming(false)}
                          disabled={deleteBusy}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn-del btn-sm"
                      onClick={() => setDeleteConfirming(true)}
                      disabled={saving}
                    >
                      Delete Account
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export type { RestaurantUser };
