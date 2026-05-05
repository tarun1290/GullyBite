'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '../../../contexts/AdminAuthContext';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import { getAdminUsers, updateAdminUser } from '../../../api/admin';

interface AdminPermissions {
  customer_full_phone?: boolean;
}

interface AdminUserRow {
  id: string;
  name?: string;
  email?: string;
  role?: string;
  is_active?: boolean;
  permissions?: AdminPermissions;
}

const th: CSSProperties = { padding: '.5rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.5rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };

export default function AdminAdminsPage() {
  const { user } = useAdminAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const isSuper = (user as { admin_tier?: string } | null)?.admin_tier === 'super_admin';

  const load = useCallback(async () => {
    if (!isSuper) { setLoading(false); return; }
    setLoading(true);
    try {
      const users = (await getAdminUsers()) as AdminUserRow[] | null;
      setRows(Array.isArray(users) ? users : []);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setErr(er?.response?.data?.error || er?.message || 'Failed to load admin users');
    } finally {
      setLoading(false);
    }
  }, [isSuper]);

  useEffect(() => { load(); }, [load]);

  const toggleFullPhone = async (u: AdminUserRow, next: boolean) => {
    setBusyId(u.id);
    try {
      await updateAdminUser(u.id, { customer_full_phone: next });
      showToast(next ? 'Full-phone access granted' : 'Full-phone access revoked', 'success');
      setRows((prev) => prev.map((x) => x.id === u.id
        ? { ...x, permissions: { ...(x.permissions || {}), customer_full_phone: next } }
        : x));
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Update failed', 'error');
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
                      <td style={td}>{u.is_active === false ? <span style={{ color: 'var(--gb-red-600)' }}>disabled</span> : 'yes'}</td>
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
