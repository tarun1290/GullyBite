'use client';

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../Toast';
import UserFormModal, { type RestaurantUser } from './UserFormModal';
import {
  getUsers,
  getBranches,
  deleteUser,
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
              <p className="text-dim text-[0.84rem]">
                Add managers, kitchen staff or delivery partners.
              </p>
            </div>
          ) : (
            <div className="tbl overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[0.72rem] text-dim uppercase tracking-[0.5px]">
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
                        <td className="p-2 text-[0.86rem]">{u.name}</td>
                        <td className="p-2 text-[0.75rem] text-dim">{u.phone}</td>
                        <td className="p-2 text-center">
                          <span
                            className="font-semibold text-[0.8rem]"
                            // role badge colour from ROLE_BADGE by u.role at
                            // runtime (owner/manager/kitchen/delivery — 4
                            // distinct CSS vars, plus a dim fallback).
                            style={{ color: rb.color }}
                          >
                            {rb.emoji} {rb.label}
                          </span>
                        </td>
                        <td className="p-2 text-[0.75rem]">{brNames}</td>
                        <td className="p-2 text-center">
                          {u.is_active ? (
                            <span className="text-wa">✓</span>
                          ) : (
                            <span className="text-red">✗</span>
                          )}
                        </td>
                        <td className="p-2 text-[0.75rem] text-dim">
                          {formatLastLogin(u.last_login_at)}
                        </td>
                        <td className="p-2 text-center">
                          {isOwner ? (
                            <span className="text-dim text-[0.72rem]">Owner</span>
                          ) : showingPinRow ? (
                            <div className="flex items-center gap-[0.3rem] justify-end">
                              <input
                                type="password"
                                placeholder="New PIN"
                                maxLength={6}
                                value={pinValue}
                                autoFocus
                                onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ''))}
                                className="w-20 py-[0.2rem] px-[0.4rem] border border-rim rounded-sm text-[0.78rem]"
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
                            <div className="flex gap-[0.3rem] justify-end">
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
                                  back from the server. */}
                              {recentResetPin && recentResetPin.userId === u.id && (
                                <div className="inline-flex items-center gap-1 py-[0.15rem] px-[0.4rem] border border-rim rounded-md bg-acc-glow text-[0.7rem] font-mono">
                                  <span className="text-dim">PIN:</span>
                                  <span className="font-semibold text-tx tracking-wider">
                                    {recentResetRevealed ? recentResetPin.pin : '••••'}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setRecentResetRevealed((v) => !v)}
                                    className="bg-transparent border-0 cursor-pointer text-[0.72rem] leading-none"
                                    aria-label={recentResetRevealed ? 'Hide PIN' : 'Reveal PIN'}
                                  >
                                    {recentResetRevealed ? '🙈' : '👁'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={copyRecentPin}
                                    className="bg-transparent border-0 cursor-pointer text-[0.7rem] text-acc font-semibold"
                                  >
                                    {recentResetCopied ? 'Copied!' : 'Copy'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={dismissRecentPin}
                                    className="bg-transparent border-0 cursor-pointer text-[0.7rem] text-dim leading-none"
                                    aria-label="Dismiss"
                                  >
                                    ×
                                  </button>
                                </div>
                              )}
                              <button
                                type="button"
                                className="btn-outline btn-sm text-[0.72rem]"
                                onClick={() => openEdit(u)}
                                disabled={rowBusy === u.id}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn-outline btn-sm text-[0.72rem] text-gold"
                                onClick={() => startPinReset(u)}
                                disabled={rowBusy === u.id}
                              >
                                Reset PIN
                              </button>
                              {u.is_active ? (
                                <button
                                  type="button"
                                  className="btn-outline btn-sm text-[0.72rem] text-red"
                                  onClick={() => setPendingDeactivate(u.id)}
                                  disabled={rowBusy === u.id}
                                >
                                  Deactivate
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn-outline btn-sm text-[0.72rem] text-wa"
                                  onClick={() => handleToggleActive(u)}
                                  disabled={rowBusy === u.id}
                                >
                                  {rowBusy === u.id ? '…' : 'Activate'}
                                </button>
                              )}
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
