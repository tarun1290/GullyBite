'use client';

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../Toast';
import UserFormModal, { type RestaurantUser } from './UserFormModal';
import {
  getUsers,
  getBranches,
  deleteUser,
  updateUser,
  resetUserPin,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

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
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'PIN reset failed', 'error');
    } finally {
      setPinBusy(false);
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
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>👥 Team</h3>
          <button type="button" className="btn-p btn-sm" onClick={openAdd}>
            + Add Team Member
          </button>
        </div>
        <div className="cb">
          {loading ? (
            <p style={{ color: 'var(--dim)' }}>Loading team…</p>
          ) : !users.length ? (
            <div className="empty" style={{ textAlign: 'center', padding: '2rem 0' }}>
              <div className="ei" style={{ fontSize: '2.5rem' }}>👥</div>
              <h3>No team members yet</h3>
              <p style={{ color: 'var(--dim)', fontSize: '.84rem' }}>
                Add managers, kitchen staff or delivery partners.
              </p>
            </div>
          ) : (
            <div className="tbl" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', fontSize: '.72rem', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.5px' }}>
                    <th style={{ padding: '.5rem' }}>Name</th>
                    <th style={{ padding: '.5rem' }}>Phone</th>
                    <th style={{ padding: '.5rem', textAlign: 'center' }}>Role</th>
                    <th style={{ padding: '.5rem' }}>Branches</th>
                    <th style={{ padding: '.5rem', textAlign: 'center' }}>Active</th>
                    <th style={{ padding: '.5rem' }}>Last Login</th>
                    <th style={{ padding: '.5rem', textAlign: 'center' }}>Actions</th>
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
                        style={{
                          borderBottom: '1px solid var(--rim)',
                          opacity: u.is_active ? 1 : 0.55,
                        }}
                      >
                        <td style={{ padding: '.5rem', fontSize: '.86rem' }}>{u.name}</td>
                        <td style={{ padding: '.5rem', fontSize: '.75rem', color: 'var(--dim)' }}>{u.phone}</td>
                        <td style={{ padding: '.5rem', textAlign: 'center' }}>
                          <span style={{ color: rb.color, fontWeight: 600, fontSize: '.8rem' }}>
                            {rb.emoji} {rb.label}
                          </span>
                        </td>
                        <td style={{ padding: '.5rem', fontSize: '.75rem' }}>{brNames}</td>
                        <td style={{ padding: '.5rem', textAlign: 'center' }}>
                          {u.is_active ? (
                            <span style={{ color: 'var(--wa,#22c55e)' }}>✓</span>
                          ) : (
                            <span style={{ color: 'var(--red,#dc2626)' }}>✗</span>
                          )}
                        </td>
                        <td style={{ padding: '.5rem', fontSize: '.75rem', color: 'var(--dim)' }}>
                          {formatLastLogin(u.last_login_at)}
                        </td>
                        <td style={{ padding: '.5rem', textAlign: 'center' }}>
                          {isOwner ? (
                            <span style={{ color: 'var(--dim)', fontSize: '.72rem' }}>Owner</span>
                          ) : showingPinRow ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '.3rem', justifyContent: 'flex-end' }}>
                              <input
                                type="password"
                                placeholder="New PIN"
                                maxLength={6}
                                value={pinValue}
                                autoFocus
                                onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ''))}
                                style={{ width: 80, padding: '.2rem .4rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.78rem' }}
                              />
                              <button
                                type="button"
                                className="btn-p btn-sm"
                                style={{ fontSize: '.7rem' }}
                                onClick={() => handleResetPin(u)}
                                disabled={pinBusy}
                              >
                                {pinBusy ? '…' : 'Save'}
                              </button>
                              <button
                                type="button"
                                className="btn-g btn-sm"
                                style={{ fontSize: '.7rem' }}
                                onClick={cancelPinReset}
                                disabled={pinBusy}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : showingDeactivateRow ? (
                            <div style={{ display: 'flex', gap: '.3rem', justifyContent: 'flex-end' }}>
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
                                className="btn-g btn-sm"
                                style={{ fontSize: '.72rem' }}
                                onClick={() => setPendingDeactivate(null)}
                                disabled={rowBusy === u.id}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: '.25rem', justifyContent: 'flex-end' }}>
                              <button
                                type="button"
                                className="btn-outline btn-sm"
                                style={{ fontSize: '.72rem' }}
                                onClick={() => openEdit(u)}
                                disabled={rowBusy === u.id}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn-outline btn-sm"
                                style={{ fontSize: '.72rem', color: 'var(--gold,#f59e0b)' }}
                                onClick={() => startPinReset(u)}
                                disabled={rowBusy === u.id}
                              >
                                PIN
                              </button>
                              {u.is_active ? (
                                <button
                                  type="button"
                                  className="btn-outline btn-sm"
                                  style={{ fontSize: '.72rem', color: 'var(--red,#dc2626)' }}
                                  onClick={() => setPendingDeactivate(u.id)}
                                  disabled={rowBusy === u.id}
                                >
                                  Deactivate
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn-outline btn-sm"
                                  style={{ fontSize: '.72rem', color: 'var(--wa,#16a34a)' }}
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
