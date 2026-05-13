'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../Toast';
import UserFormModal, { type RestaurantUser } from './UserFormModal';
import {
  getUsers,
  getBranches,
  deleteUser,
  updateUser,
  resetUserPin,
} from '../../api/restaurant';
import {
  listStaff,
  deactivateStaff,
  generateStaffLoginId,
  resetStaffPin,
  updateStaff,
} from '../../api/staff';
import type { Branch, Staff } from '../../types';

interface RoleBadge { emoji: string; color: string; label: string }

const ROLE_BADGE: Record<string, RoleBadge> = {
  owner: { emoji: '👑', color: 'var(--acc)', label: 'Owner' },
  manager: { emoji: '📋', color: 'var(--wa,#22c55e)', label: 'Manager' },
  staff: { emoji: '🧑‍🍳', color: 'var(--gold,#f59e0b)', label: 'Staff' },
  kitchen: { emoji: '👨‍🍳', color: 'var(--gold,#f59e0b)', label: 'Kitchen' },
  delivery: { emoji: '🚴', color: 'var(--blue,#3b82f6)', label: 'Delivery' },
};

// Discriminated union: rows from getUsers() carry __source: 'legacy',
// rows from listStaff() carry __source: 'staff-app'. Backend roles are
// disjoint between the two endpoints (owner/kitchen/delivery on the
// legacy side, manager/staff on the staff-app side), but we still
// guard with a Set on row id below in case that ever drifts.
type MergedRow =
  | (RestaurantUser & { __source: 'legacy' })
  | (Staff & { __source: 'staff-app'; id: string; branch_ids: string[]; last_login_at?: string });

// Normalize a Staff row from listStaff() so all downstream rendering
// can read `row.id`, `row.name`, `row.branch_ids`, `row.last_login_at`
// without caring which API the row came from.
function normalizeStaff(s: Staff): MergedRow {
  return {
    ...s,
    id: s._id,
    name: s.display_name || s.name,
    branch_ids: (s.branch_ids?.length ? s.branch_ids : s.branchIds) || [],
    last_login_at: s.last_active_at,
    __source: 'staff-app',
  } as MergedRow;
}

function isStaffAppRow(row: MergedRow): boolean {
  return row.role === 'staff' || row.role === 'manager';
}

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
  const [users, setUsers] = useState<MergedRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editing, setEditing] = useState<MergedRow | null>(null);

  const [pinRowId, setPinRowId] = useState<string | null>(null);
  const [pinValue, setPinValue] = useState<string>('');
  const [pinBusy, setPinBusy] = useState<boolean>(false);
  const [pendingDeactivate, setPendingDeactivate] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  // Post-reset transient display. After a successful reset-pin call we
  // briefly surface the PIN — for legacy rows the value is whatever the
  // owner just typed; for staff-app rows it's the server-generated PIN
  // returned in the response.generated_pin field. State only — never
  // sent to the server, never stored in localStorage. Auto-clears.
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
      const [staffList, legacyRaw, branchRaw] = await Promise.all([
        listStaff(),
        getUsers() as Promise<RestaurantUser[] | null>,
        getBranches(),
      ]);
      const legacyList: RestaurantUser[] = Array.isArray(legacyRaw) ? legacyRaw : [];
      // Defensive Set guard on id — backend role sets are disjoint, but
      // if a row ever appears on both sides we keep the staff-app copy
      // (it's the canonical source for managers/staff going forward).
      const seen = new Set<string>();
      const merged: MergedRow[] = [];
      for (const s of Array.isArray(staffList) ? staffList : []) {
        const row = normalizeStaff(s);
        if (!row.id) continue;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(row);
      }
      for (const u of legacyList) {
        if (!u || !u.id) continue;
        if (seen.has(u.id)) continue;
        seen.add(u.id);
        merged.push({ ...u, __source: 'legacy' });
      }
      setUsers(merged);
      setBranches(Array.isArray(branchRaw) ? branchRaw : []);
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

  const openEdit = (u: MergedRow) => {
    setEditing(u);
    setModalOpen(true);
  };

  // Copy a staff-app row's staff_id (the operator's login identifier
  // for the staff app, labeled "Staff ID" on the login screen). Only
  // meaningful for staff-app rows — legacy rows (kitchen/delivery/owner)
  // log in via owner-side phone+PIN through /api/restaurant/users and
  // don't carry a staff_id. The kebab menuitem below is gated on
  // isStaffAppRow(u) so the button is only rendered when this works.
  const copyStaffLoginId = async (u: MergedRow) => {
    if (!isStaffAppRow(u)) return;
    const sid = (u as MergedRow & { staff_id?: string }).staff_id;
    if (!sid) return; // separate handler covers the null case (see below)
    try {
      await navigator.clipboard.writeText(sid);
      showToast('Login ID copied', 'success');
    } catch {
      showToast('Could not copy — select the ID manually', 'error');
    }
  };

  // Generate a Login ID for a staff-app row whose staff_id is null
  // (legacy rows from before the 2026-05-12 fix that gated generation
  // on role==='staff' only). Calls POST /api/restaurant/staff/:id/
  // generate-login-id, updates the in-memory row, copies the new
  // value to clipboard, and toasts. Refuses to act on a row that
  // already has staff_id — the backend returns 400 in that case and
  // we surface the existing value via load() refresh instead.
  const generateLoginIdForRow = async (u: MergedRow) => {
    if (!isStaffAppRow(u)) return;
    setRowBusy(u.id);
    try {
      const res = await generateStaffLoginId(u.id);
      const newId = res.staff_id;
      // Reflect immediately in the table so the operator sees the
      // value without waiting for a full refetch. load() runs in the
      // background to keep server state authoritative.
      setUsers((prev) => prev.map((row) =>
        row.id === u.id ? ({ ...row, staff_id: newId } as MergedRow) : row,
      ));
      try {
        await navigator.clipboard.writeText(newId);
        showToast(`Login ID generated: ${newId} (copied)`, 'success');
      } catch {
        showToast(`Login ID generated: ${newId}`, 'success');
      }
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Generate failed', 'error');
    } finally {
      setRowBusy(null);
    }
  };

  const handleToggleActive = async (u: MergedRow) => {
    setRowBusy(u.id);
    try {
      if (u.is_active) {
        if (isStaffAppRow(u)) {
          await deactivateStaff(u.id);
        } else {
          await deleteUser(u.id);
        }
        showToast(`${u.name} deactivated`, 'success');
      } else {
        if (isStaffAppRow(u)) {
          await updateStaff(u.id, { is_active: true });
        } else {
          await updateUser(u.id, { isActive: true });
        }
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

  // Legacy-row PIN reset — the owner types the new PIN inline. The
  // backend hashes and stores it; we surface the just-typed value in
  // the recent-reset chip so it can be copied/shared before clearing.
  const handleResetPin = async (u: MergedRow) => {
    const pin = pinValue.trim();
    if (!/^\d{4,6}$/.test(pin)) { showToast('PIN must be 4–6 digits', 'error'); return; }
    setPinBusy(true);
    try {
      await resetUserPin(u.id, pin);
      showToast(`PIN reset for ${u.name}`, 'success');
      setPinRowId(null);
      setPinValue('');
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

  // Staff-app PIN reset — backend mints the new PIN itself and returns
  // it in the response. There's no inline-typed value to surface; the
  // chip shows whatever the server generated. No PIN-input row is
  // rendered for these rows; the kebab "Reset PIN" item triggers this
  // helper directly.
  const handleResetStaffApp = async (u: MergedRow) => {
    setRowBusy(u.id);
    try {
      const res = await resetStaffPin(u.id);
      const pin = res?.generated_pin;
      if (pin) {
        setRecentResetPin({ userId: u.id, pin });
        setRecentResetRevealed(false);
        setRecentResetCopied(false);
        window.setTimeout(() => {
          setRecentResetPin((cur) => (cur && cur.userId === u.id ? null : cur));
        }, RESET_DISPLAY_MS);
        showToast(`PIN reset for ${u.name}`, 'success');
      } else {
        showToast('Reset succeeded but server returned no PIN', 'error');
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'PIN reset failed', 'error');
    } finally {
      setRowBusy(null);
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

  const startPinReset = (u: MergedRow) => {
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
                    <th className="p-2">Login ID</th>
                    <th className="p-2">Branches</th>
                    <th className="p-2 text-center">Active</th>
                    <th className="p-2">Last Login</th>
                    <th className="p-2 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const rb = ROLE_BADGE[u.role || ''] || { emoji: '', color: 'var(--dim)', label: u.role || '' };
                    const brIds = u.branch_ids || [];
                    const brNames = brIds.length
                      ? brIds.map((id) => branchMap[id] || id).join(', ')
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
                            // runtime (owner/manager/staff/kitchen/delivery —
                            // 5 distinct CSS vars, plus a dim fallback).
                            // Inline style is the right tool here: Tailwind's
                            // JIT can't see dynamically-selected class names.
                            style={{ color: rb.color }}
                          >
                            {rb.emoji} {rb.label}
                          </span>
                        </td>
                        <td className="p-2 text-xs">
                          {isStaffAppRow(u) ? (
                            (u as MergedRow & { staff_id?: string | null }).staff_id ? (
                              <button
                                type="button"
                                className="font-mono text-tx bg-transparent border-0 cursor-pointer hover:underline px-0 py-0"
                                onClick={() => void copyStaffLoginId(u)}
                                title="Click to copy"
                              >
                                {((u as MergedRow & { staff_id?: string }).staff_id || '').slice(0, 8)}
                                {((u as MergedRow & { staff_id?: string }).staff_id || '').length > 8 ? '…' : ''}
                                {' '}📋
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn-g btn-xs"
                                onClick={() => void generateLoginIdForRow(u)}
                                disabled={rowBusy === u.id}
                              >
                                {rowBusy === u.id ? '…' : 'Generate'}
                              </button>
                            )
                          ) : (
                            <span className="text-dim">—</span>
                          )}
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
                                    {/* Staff-app rows only — recovery
                                        path for the Login ID that the
                                        create reveal panel surfaced
                                        once. staff_id is exposed by
                                        sanitizeStaff on GET /staff so
                                        no extra API call is needed. */}
                                    {isStaffAppRow(u) && (
                                      (u as MergedRow & { staff_id?: string | null }).staff_id ? (
                                        <button
                                          type="button"
                                          role="menuitem"
                                          className="block w-full text-left px-4 py-2 text-sm hover:bg-ink2 cursor-pointer"
                                          onClick={() => { setKebabOpenId(null); void copyStaffLoginId(u); }}
                                        >
                                          Copy Login ID
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          role="menuitem"
                                          className="block w-full text-left px-4 py-2 text-sm hover:bg-ink2 cursor-pointer"
                                          onClick={() => { setKebabOpenId(null); void generateLoginIdForRow(u); }}
                                          disabled={rowBusy === u.id}
                                        >
                                          {rowBusy === u.id ? 'Generating…' : 'Generate Login ID'}
                                        </button>
                                      )
                                    )}
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="block w-full text-left px-4 py-2 text-sm hover:bg-ink2 cursor-pointer"
                                      onClick={() => {
                                        setKebabOpenId(null);
                                        if (isStaffAppRow(u)) {
                                          handleResetStaffApp(u);
                                        } else {
                                          startPinReset(u);
                                        }
                                      }}
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
        mode={!editing ? 'staff-app' : (isStaffAppRow(editing) ? 'staff-app' : 'legacy')}
        onClose={() => setModalOpen(false)}
        editing={editing as RestaurantUser | null}
        branches={branches}
        onSaved={load}
      />
    </div>
  );
}
