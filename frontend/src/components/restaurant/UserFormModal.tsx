'use client';

import { useEffect, useState } from 'react';
import { useToast } from '../Toast';
import { createUser, updateUser, getBranchStaffLink } from '../../api/restaurant';
import type { Branch, BranchStaffLink } from '../../types';

// Per-branch login-link row used by the post-creation success screen.
// `status` distinguishes a still-loading fetch from a resolved value or
// an outright fetch failure so each row can render its own state
// without blocking the others (Promise.allSettled wires this).
interface BranchLink {
  branchId: string;
  branchName: string;
  status: 'loading' | 'ready' | 'error';
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

  useEffect(() => {
    if (!open) {
      // Clear success state when the modal fully closes so a re-open
      // (Add Member again) starts on the form.
      setCreated(null);
      setBranchLinks([]);
      setCopiedBranchId(null);
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
      }, 1500);
    } catch {
      showToast('Could not copy — select the link and copy manually', 'error');
    }
  };

  const isEdit = !!editing;

  const toggleBranch = (id: string) => {
    setForm((f) => ({
      ...f,
      branchIds: f.branchIds.includes(id)
        ? f.branchIds.filter((x) => x !== id)
        : [...f.branchIds, id],
    }));
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
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={{ width: 440, maxWidth: '95vw', background: 'var(--surface,#fff)' }}>
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>{created ? 'Team member added!' : (isEdit ? 'Edit Team Member' : 'Add Team Member')}</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{ background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer' }}
          >
            ×
          </button>
        </div>
        <div className="cb">
          {created ? (
            // ── Post-creation success screen ───────────────────────
            <>
              <div style={{ marginBottom: '.8rem', padding: '.6rem .75rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8 }}>
                <div style={{ fontWeight: 700, color: '#15803d', fontSize: '.92rem' }}>
                  ✓ {created.name}
                </div>
                <div style={{ fontSize: '.78rem', color: '#166534', textTransform: 'capitalize' }}>
                  {created.role}
                </div>
              </div>

              <div className="fg" style={{ marginBottom: '.7rem' }}>
                <label>Branch Login URLs</label>
                {created.branchIds.length === 0 ? (
                  <div style={{ marginTop: '.3rem', padding: '.55rem .7rem', background: 'var(--ink2,#f4f4f5)', border: '1px solid var(--rim)', borderRadius: 6, fontSize: '.78rem', color: 'var(--dim)' }}>
                    Share the branch login URL with your team member from the Branches tab.
                  </div>
                ) : (
                  <div
                    style={{
                      marginTop: '.3rem',
                      maxHeight: 220,
                      overflowY: 'auto',
                      border: '1px solid var(--rim)',
                      borderRadius: 6,
                    }}
                  >
                    {branchLinks.map((row) => (
                      <div
                        key={row.branchId}
                        style={{
                          padding: '.55rem .7rem',
                          borderBottom: '1px solid var(--bdr,#e5e7eb)',
                          fontSize: '.8rem',
                        }}
                      >
                        <div style={{ fontWeight: 600, marginBottom: '.2rem' }}>{row.branchName}</div>
                        {row.status === 'loading' && (
                          <div style={{ fontSize: '.74rem', color: 'var(--dim)' }}>Loading…</div>
                        )}
                        {row.status === 'ready' && row.url && (
                          <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
                            <input
                              value={row.url}
                              readOnly
                              onFocus={(e) => e.currentTarget.select()}
                              style={{
                                flex: 1,
                                fontFamily: 'monospace',
                                fontSize: '.74rem',
                                background: 'var(--ink2,#f4f4f5)',
                                border: '1px solid var(--rim)',
                                borderRadius: 4,
                                padding: '.25rem .4rem',
                                color: 'var(--dim)',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => copyLink(row.branchId, row.url || '')}
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--bdr,#e5e7eb)',
                                color: 'var(--dim)',
                                fontSize: '.7rem',
                                padding: '.2rem .5rem',
                                borderRadius: 4,
                                cursor: 'pointer',
                                flexShrink: 0,
                              }}
                            >
                              {copiedBranchId === row.branchId ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                        )}
                        {row.status === 'ready' && !row.url && (
                          <div style={{ fontSize: '.72rem', color: '#92400e' }}>
                            ⚠ {row.errorMessage || 'No login link yet — generate one from the Branches tab.'}
                          </div>
                        )}
                        {row.status === 'error' && (
                          <div style={{ fontSize: '.72rem', color: 'var(--red,#dc2626)' }}>
                            Could not load — {row.errorMessage}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '.5rem', marginTop: '.8rem' }}>
                <button type="button" className="btn-p" onClick={onClose}>Done</button>
              </div>
            </>
          ) : (
            // ── Form (create / edit) ───────────────────────────────
            <>
              <div className="fg" style={{ marginBottom: '.7rem' }}>
                <label>Name ★</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Rahul Sharma"
                />
              </div>
              <div className="fg" style={{ marginBottom: '.7rem' }}>
                <label>Phone {isEdit ? '' : '★'}</label>
                <input
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="+91 98765 43210"
                  disabled={isEdit}
                  style={isEdit ? { opacity: 0.6 } : undefined}
                />
                {isEdit && (
                  <div style={{ fontSize: '.7rem', color: 'var(--dim)', marginTop: '.2rem' }}>
                    Phone is locked after creation.
                  </div>
                )}
              </div>
              {!isEdit && (
                <div className="fg" style={{ marginBottom: '.7rem' }}>
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
              <div className="fg" style={{ marginBottom: '.7rem' }}>
                <label>Role ★</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  style={{ padding: '.5rem', border: '1px solid var(--rim)', borderRadius: 'var(--r,6px)', width: '100%' }}
                >
                  {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="fg" style={{ marginBottom: '.7rem' }}>
                <label>Branches <small style={{ color: 'var(--dim)' }}>(leave empty for all)</small></label>
                {(branches || []).length > 0 ? (
                  <div
                    style={{
                      marginTop: '.3rem',
                      maxHeight: 220,
                      overflowY: 'auto',
                      border: '1px solid var(--rim)',
                      borderRadius: 6,
                    }}
                  >
                    {(branches || []).map((b) => {
                      const on = form.branchIds.includes(b.id);
                      return (
                        <label
                          key={b.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '.5rem',
                            padding: '.45rem .7rem',
                            borderBottom: '1px solid var(--bdr,#e5e7eb)',
                            cursor: 'pointer',
                            background: on ? 'rgba(34,197,94,.08)' : 'transparent',
                            fontSize: '.85rem',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggleBranch(b.id)}
                            style={{ flexShrink: 0 }}
                          />
                          <span>{b.name}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>No branches yet.</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '.5rem', marginTop: '.8rem' }}>
                <button type="button" className="btn-p" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Member')}
                </button>
                <button type="button" className="btn-g" onClick={onClose} disabled={saving}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export type { RestaurantUser };
