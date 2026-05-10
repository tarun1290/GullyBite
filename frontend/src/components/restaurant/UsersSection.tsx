'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../Toast';
import UserFormModal, { type RestaurantUser } from './UserFormModal';
import {
  getUsers,
  getBranches,
  deleteUser,
  deleteStaffHard,
  updateUser,
  resetUserPin,
} from '../../api/restaurant';
import type { Branch } from '../../types';

interface RoleBadge { emoji: string; color: string; label: string }

const ROLE_BADGE: Record<string, RoleBadge> = {
  owner: { emoji: '👑', color: 'var(--acc)', label: 'Owner' },
  manager: { emoji: '📋', color: 'var(--wa,#22c55e)', label: 'Manager' },
  kitchen: { emoji: '👨‍🍳', color: 'var(--gold,#f59e0b)', label: 'Kitchen' },
  delivery: { emoji: '🚴', color: 'var(--blue,#3b82f6)', label: 'Delivery' },
};

function formatLastLogin(ts?: string): string {
  if (!ts) return 'Never';
  try {
    return new Date(ts).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return 'Never';
  }
}

export default function UsersSection() {
  const { showToast } = useToast();
  const [users, setUsers] = useState<RestaurantUser[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editing, setEditing] = useState<RestaurantUser | null>(null);

  const [pinRowId, setPinRowId] = useState<string | null>(null);
  const [pinValue, setPinValue] = useState<string>('');
  const [pinBusy, setPinBusy] = useState<boolean>(false);
  const [pendingDeactivate, setPendingDeactivate] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  // Post-reset transient display. After a successful reset-pin call we
  // briefly surface the PIN the owner just typed (NOT fetched from the
  // server — the backend never persists plaintext, only bcrypt's
  // pin_hash) so it can be copied/pasted into WhatsApp without retyping.
  // Auto-clears after the timeout below or on the next reset/cancel.
  const [recentResetPin, setRecentResetPin] = useState<{ userId: string; pin: string } | null>(null);
  const [recentResetRevealed, setRecentResetRevealed] = useState<boolean>(false);
  const [recentResetCopied, setRecentResetCopied] = useState<boolean>(false);
  const RESET_DISPLAY_MS = 60_000;

  // Kebab menu state — single open ID across all rows (only one menu
  // can be open at a time). The ref below captures whichever row's
  // wrapper is currently open so the document-level mousedown listener
  // can detect outside clicks without per-row refs.
  const [kebabOpenId, setKebabOpenId] = useState<string | null>(null);
  const openKebabWrapperRef = useRef<HTMLDivElement | null>(null);

  // Hard-delete confirm row — distinct from pendingDeactivate (soft).
  // Shown inline in the actions cell once the kebab "Delete Account"
  // item is selected; calls deleteStaffHard via api/restaurant.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState<boolean>(false);

  // Close the kebab on click outside. Only attaches the listener while
  // a menu is open so we're not paying for it on every mousedown when
  // no menu is up. Same pattern as NotificationBell.tsx.
  useEffect(() => {
    if (!kebabOpenId) return undefined;
    const onMouseDown = (e: MouseEvent) => {
      const wrap = openKebabWrapperRef.current;
      if (wrap && !wrap.contains(e.target as Node)) {
        setKebabOpenId(null);
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [kebabOpenId]);

  const load = async () => {
    setLoading(true);
    try {
      const [u, b] = await Promise.all([getUsers() as Promise<RestaurantUser[] | null>, getBranches()]);
      setUsers(Array.isArray(u) ? u : []);
      setBranches(Array.isArray(b) ? b : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load team', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const branchMap = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    branches.forEach((b) => { m[b.id] = b.name; });
    return m;
  }, [branches]);

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (u: RestaurantUser) => {
    setEditing(u);
    setModalOpen(true);
  };

  const handleToggleActive = async (u: RestaurantUser) => {
    setRowBusy(u.id);
    try {
      if (u.is_active) {
        await deleteUser(u.id);
        showToast(`${u.name} deactivated`, 'success');
      } else {
        await updateUser(u.id, { isActive: true });
        showToast(`${u.name} activated`, 'success');
      }
      setPendingDeactivate(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Update failed', 'error');
    } finally {
      setRowBusy(null);
    }
  };

  const handleResetPin = async (u: RestaurantUser) => {
    const pin = pinValue.trim();
    if (!/^\d{4,6}$/.test(pin)) { showToast('PIN must be 4–6 digits', 'error'); return; }
    setPinBusy(true);
    try {
      await resetUserPin(u.id, pin);
      showToast(`PIN reset for ${u.name}`, 'success');
      setPinRowId(null);
      setPinValue('');
      // Surface the just-set PIN inline so the owner can copy/share it
      // before it disappears. State only — never sent to the server,
      // never stored in localStorage. Auto-clears after RESET_DISPLAY_MS.
      setRecentResetPin({ userId: u.id, pin });
      setRecentResetRevealed(false);
      setRecentResetCopied(false);
      window.setTimeout(() => {
        setRecentResetPin((cur) => (cur && cur.userId === u.id ? null : cur));
      }, RESET_DISPLAY_MS);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'PIN reset failed', 'error');
    } finally {
      setPinBusy(false);
    }
  };

  const copyRecentPin = async () => {
    if (!recentResetPin) return;
    try {
      await navigator.clipboard.writeText(recentResetPin.pin);
      setRecentResetCopied(true);
      window.setTimeout(() => setRecentResetCopied(false), 2000);
    } catch {
      showToast('Could not copy — select and copy manually', 'error');
    }
  };

  const dismissRecentPin = () => {
    setRecentResetPin(null);
    setRecentResetRevealed(false);
    setRecentResetCopied(false);
  };

  // Hard delete — invoked from the kebab menu's "Delete Account" option
  // after the inline confirm row's Confirm button. Hits the dedicated
  // /staff/:staffId hard-delete endpoint (NOT the soft /users/:id path
  // used by handleToggleActive's Deactivate flow).
  const handleHardDelete = async (u: RestaurantUser) => {
    setDeleteBusy(true);
    try {
      await deleteStaffHard(u.id);
      showToast(`${u.name} deleted`, 'success');
      setPendingDelete(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
    } finally {
      setDeleteBusy(false);
    }
  };

  const startPinReset = (u: RestaurantUser) => {
    setPinRowId(u.id);
    setPinValue('');
    setPendingDeactivate(null);
  };

  const cancelPinReset = () => {
    setPinRowId(null);
    setPinValue('');
  };

  return (
    <div>
      <div className="card">
        <div className="ch justify-between">
          <h3>👥 Team</h3>
          <button type="button" className="btn-p btn-sm" onClick={openAdd}>
            + Add Team Member
          </button>
        </div>
        <div className="cb">
          {loading ? (
            <p className="text-dim">Loading team…</p>
          ) : !users.length ? (
            <div className="empty text-center py-8">
              <div className="ei text-[2.5rem]">👥</div>
              <h3>No team members yet</h3>
              <p className="text-dim text-sm">
                Add managers, kitchen staff or delivery partners.
              </p>
            </div>
          ) : (
            <div className="tbl overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-xs text-dim uppercase tracking-[0.5px]">
                    <th className="p-2">Name</th>
                    <th className="p-2">Phone</th>
                    <th className="p-2 text-center">Role</th>
                    <th className="p-2">Branches</th>
                    <th className="p-2 text-center">Active</th>
                    <th className="p-2">Last Login</th>
                    <th className="p-2 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const rb = ROLE_BADGE[u.role || ''] || { emoji: '', color: 'var(--dim)', label: u.role || '' };
                    const brNames = (u.branch_ids || []).length
                      ? (u.branch_ids || []).map((id) => branchMap[id] || id).join(', ')
                      : 'All';
                    const isOwner = u.role === 'owner';
                    const showingPinRow = pinRowId === u.id;
                    const showingDeactivateRow = pendingDeactivate === u.id;
                    return (
                      <tr
                        key={u.id}
                        className={`border-b border-rim ${u.is_active ? 'opacity-100' : 'opacity-55'}`}
                      >
                        <td className="p-2 text-base">{u.name}</td>
                        <td className="p-2 text-xs text-dim">{u.phone}</td>
                        <td className="p-2 text-center">
                          <span
                            className="font-semibold text-sm"
                            // role badge colour from ROLE_BADGE by u.role at
                            // runtime (owner/manager/kitchen/delivery — 4
                            // distinct CSS vars, plus a dim fallback).
                            style={{ color: rb.color }}
                          >
                            {rb.emoji} {rb.label}
                          </span>
                        </td>
                        <td className="p-2 text-xs">{brNames}</td>
                        <td className="p-2 text-center">
                          {u.is_active ? (
                            <span className="text-wa">✓</span>
                          ) : (
                            <span className="text-red">✗</span>
                          )}
                        </td>
                        <td className="p-2 text-xs text-dim">
                          {formatLastLogin(u.last_login_at)}
                        </td>
                        <td className="p-2 text-center">
                          {isOwner ? (
                            <span className="text-dim text-xs">Owner</span>
                          ) : showingPinRow ? (
                            <div className="flex items-center gap-1 justify-end">
                              <input
                                type="password"
                                placeholder="New PIN"
                                maxLength={6}
                                value={pinValue}
                                autoFocus
                                onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ''))}
                                className="w-20 py-1 px-1.5 border border-rim rounded-sm text-sm"
                              />
                              <button
                                type="button"
                                className="btn-p btn-xs"
                                onClick={() => handleResetPin(u)}
                                disabled={pinBusy}
                              >
                                {pinBusy ? '…' : 'Save'}
                              </button>
                              <button
                                type="button"
                                className="btn-g btn-xs"
                                onClick={cancelPinReset}
                                disabled={pinBusy}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : showingDeactivateRow ? (
                            <div className="flex gap-1 justify-end">
                              <button
                                type="button"
                                className="btn-del btn-sm"
                                onClick={() => handleToggleActive(u)}
                                disabled={rowBusy === u.id}
                              >
                                {rowBusy === u.id ? '…' : `Deactivate ${u.name}`}
                              </button>
                              <button
                                type="button"
                                className="btn-g btn-xs"
                                onClick={() => setPendingDeactivate(null)}
                                disabled={rowBusy === u.id}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : pendingDelete === u.id ? (
                            // Hard-delete confirm — distinct copy from
                            // Deactivate so the operator can't conflate
                            // the two destructive paths.
                            <div className="flex flex-col gap-1 items-end">
                              <span className="text-xs text-red">
                                Permanently delete {u.name}?
                              </span>
                              <div className="flex gap-1 justify-end">
                                <button
                                  type="button"
                                  className="btn-del-solid btn-sm"
                                  onClick={() => handleHardDelete(u)}
                                  disabled={deleteBusy}
                                >
                                  {deleteBusy ? '…' : 'Delete'}
                                </button>
                                <button
                                  type="button"
                                  className="btn-g btn-xs"
                                  onClick={() => setPendingDelete(null)}
                                  disabled={deleteBusy}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-1 justify-end items-center flex-wrap">
                              {/* Just-set PIN chip — appears for ~60s
                                  after a successful reset so the owner
                                  can copy/share before it auto-clears.
                                  State-only; the value isn't fetched
                                  back from the server. Stays inline
                                  (NOT moved into the kebab) because
                                  it's a transient surface, not a
                                  persistent action. */}
                              {recentResetPin && recentResetPin.userId === u.id && (
                                <div className="inline-flex items-center gap-1 py-0.5 px-1.5 border border-rim rounded-md bg-acc-glow text-xs font-mono">
                                  <span className="text-dim">PIN:</span>
                                  <span className="font-semibold text-tx tracking-wider">
                                    {recentResetRevealed ? recentResetPin.pin : '••••'}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setRecentResetRevealed((v) => !v)}
                                    className="bg-transparent border-0 cursor-pointer text-xs leading-none"
                                    aria-label={recentResetRevealed ? 'Hide PIN' : 'Reveal PIN'}
                                  >
                                    {recentResetRevealed ? '🙈' : '👁'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={copyRecentPin}
                                    className="bg-transparent border-0 cursor-pointer text-xs text-acc font-semibold"
                                  >
                                    {recentResetCopied ? 'Copied!' : 'Copy'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={dismissRecentPin}
                                    className="bg-transparent border-0 cursor-pointer text-xs text-dim leading-none"
                                    aria-label="Dismiss"
                                  >
                                    ×
                                  </button>
                                </div>
                              )}
                              {/* Kebab (vertical-ellipsis) action menu.
                                  ref is "claimed" by whichever row is
                                  currently open so the document-level
                                  outside-click listener can detect
                                  clicks landing outside this wrapper.
                                  Other rows render with ref={null}. */}
                              <div
                                ref={kebabOpenId === u.id ? openKebabWrapperRef : null}
                                className="relative inline-block"
                              >
                                <button
                                  type="button"
                                  className="btn-g btn-sm"
                                  onClick={() => setKebabOpenId((cur) => (cur === u.id ? null : u.id))}
                                  disabled={rowBusy === u.id}
                                  aria-haspopup="menu"
                                  aria-expanded={kebabOpenId === u.id}
                                  aria-label="Row actions"
                                >
                                  ⋮
                                </button>
                                {kebabOpenId === u.id && (
                                  <div
                                    role="menu"
                                    className="absolute right-0 mt-1 min-w-[160px] bg-white border border-rim rounded-md shadow-md py-1 z-50"
                                  >
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="block w-full text-left px-4 py-2 text-sm hover:bg-ink2 cursor-pointer"
                                      onClick={() => { setKebabOpenId(null); openEdit(u); }}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="block w-full text-left px-4 py-2 text-sm hover:bg-ink2 cursor-pointer"
                                      onClick={() => { setKebabOpenId(null); startPinReset(u); }}
                                    >
                                      Reset PIN
                                    </button>
                                    {u.is_active ? (
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="block w-full text-left px-4 py-2 text-sm hover:bg-ink2 cursor-pointer text-red"
                                        onClick={() => { setKebabOpenId(null); setPendingDeactivate(u.id); }}
                                      >
                                        Deactivate
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="block w-full text-left px-4 py-2 text-sm hover:bg-ink2 cursor-pointer"
                                        onClick={() => { setKebabOpenId(null); handleToggleActive(u); }}
                                      >
                                        Activate
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="block w-full text-left px-4 py-2 text-sm hover:bg-ink2 cursor-pointer text-red"
                                      onClick={() => { setKebabOpenId(null); setPendingDelete(u.id); }}
                                    >
                                      Delete Account
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <UserFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        branches={branches}
        onSaved={load}
      />
    </div>
  );
}
