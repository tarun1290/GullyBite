import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import UserFormModal from './UserFormModal.jsx';
import {
  getUsers,
  getBranches,
  deleteUser,
  updateUser,
  resetUserPin,
} from '../../../api/restaurant.js';

// Mirrors #team-table + loadTeam + editUser + resetUserPin + toggleUser
// (restaurant.js:268-381). Owner rows are read-only (legacy parity). The
// legacy `prompt()` for "Enter new PIN" and `confirm()` for deactivate are
// both replaced with inline row-state flows — no modals for those.
const ROLE_BADGE = {
  owner: { emoji: '👑', color: 'var(--acc)', label: 'Owner' },
  manager: { emoji: '📋', color: 'var(--wa,#22c55e)', label: 'Manager' },
  kitchen: { emoji: '👨‍🍳', color: 'var(--gold,#f59e0b)', label: 'Kitchen' },
  delivery: { emoji: '🚴', color: 'var(--blue,#3b82f6)', label: 'Delivery' },
};

function formatLastLogin(ts) {
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
  const [users, setUsers] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  // Inline row actions — one row at a time (null when idle).
  const [pinRowId, setPinRowId] = useState(null);
  const [pinValue, setPinValue] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pendingDeactivate, setPendingDeactivate] = useState(null);
  const [rowBusy, setRowBusy] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [u, b] = await Promise.all([getUsers(), getBranches()]);
      setUsers(Array.isArray(u) ? u : []);
      setBranches(Array.isArray(b) ? b : []);
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to load team', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const branchMap = useMemo(() => {
    const m = {};
    branches.forEach((b) => { m[b.id] = b.name; });
    return m;
  }, [branches]);

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (u) => {
    setEditing(u);
    setModalOpen(true);
  };

  const handleToggleActive = async (u) => {
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
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Update failed', 'error');
    } finally {
      setRowBusy(null);
    }
  };

  const handleResetPin = async (u) => {
    const pin = pinValue.trim();
    if (!/^\d{4,6}$/.test(pin)) {
      return showToast('PIN must be 4–6 digits', 'error');
    }
    setPinBusy(true);
    try {
      await resetUserPin(u.id, pin);
      showToast(`PIN reset for ${u.name}`, 'success');
      setPinRowId(null);
      setPinValue('');
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'PIN reset failed', 'error');
    } finally {
      setPinBusy(false);
    }
  };

  const startPinReset = (u) => {
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
                    const rb = ROLE_BADGE[u.role] || { emoji: '', color: 'var(--dim)', label: u.role };
                    const brNames = (u.branch_ids || []).length
                      ? u.branch_ids.map((id) => branchMap[id] || id).join(', ')
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
                                className="btn-sm"
                                style={{
                                  background: '#dc2626', color: '#fff', border: 'none',
                                  borderRadius: 6, padding: '.2rem .55rem', fontSize: '.72rem',
                                }}
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
