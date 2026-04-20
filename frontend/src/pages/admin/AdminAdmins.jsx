import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import { getAdminUsers, updateAdminUser } from '../../api/admin.js';

// Mirrors admin.html loadAdmins/toggleAdminFullPhone (2651-2693).
// Super-admin-only page. Minimal surface: 5-col table with the
// customer_full_phone permission toggle. Super admins always have
// full-phone access, so their toggle is locked on.

export default function AdminAdmins() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const isSuper = user?.role === 'super_admin';

  const load = useCallback(async () => {
    if (!isSuper) { setLoading(false); return; }
    setLoading(true);
    try {
      const users = await getAdminUsers();
      setRows(Array.isArray(users) ? users : []);
      setErr(null);
    } catch (e) {
      setRows([]);
      setErr(e?.response?.data?.error || e?.message || 'Failed to load admin users');
    } finally {
      setLoading(false);
    }
  }, [isSuper]);

  useEffect(() => { load(); }, [load]);

  const toggleFullPhone = async (u, next) => {
    setBusyId(u.id);
    try {
      await updateAdminUser(u.id, { customer_full_phone: next });
      showToast(next ? 'Full-phone access granted' : 'Full-phone access revoked', 'ok');
      setRows((prev) => prev.map((x) => x.id === u.id
        ? { ...x, permissions: { ...(x.permissions || {}), customer_full_phone: next } }
        : x));
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Update failed', 'err');
    } finally {
      setBusyId(null);
    }
  };

  if (!isSuper) {
    return (
      <div id="pg-admins">
        <div className="card">
          <div className="cb" style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>
            Super admin access required.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="pg-admins">
      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Admin Users</h3>
          <span style={{ color: 'var(--dim)', fontSize: '.78rem' }}>Only super admins see this page.</span>
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                  <th style={th}>Name</th>
                  <th style={th}>Email</th>
                  <th style={th}>Role</th>
                  <th style={th}>Active</th>
                  <th style={th}>Can view full phone numbers</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={5} style={emptyCell}>No admin users yet.</td></tr>
                ) : rows.map((u) => {
                  const canSee = !!(u.permissions && u.permissions.customer_full_phone) || u.role === 'super_admin';
                  const lockedSuper = u.role === 'super_admin';
                  return (
                    <tr key={u.id} style={{ borderTop: '1px solid var(--rim)' }}>
                      <td style={td}>{u.name || '—'}</td>
                      <td style={td}>{u.email || ''}</td>
                      <td style={td}>{u.role || 'admin'}</td>
                      <td style={td}>{u.is_active === false ? <span style={{ color: '#b91c1c' }}>disabled</span> : 'yes'}</td>
                      <td style={td}>
                        <label title="Can view full customer phone numbers" style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem', fontSize: '.78rem' }}>
                          <input
                            type="checkbox"
                            checked={canSee}
                            disabled={lockedSuper || busyId === u.id}
                            onChange={(e) => toggleFullPhone(u, e.target.checked)}
                          />
                          {lockedSuper ? '(super admin — always on)' : ''}
                        </label>
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
  );
}

const th = { padding: '.5rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td = { padding: '.5rem .7rem', verticalAlign: 'top' };
const emptyCell = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
