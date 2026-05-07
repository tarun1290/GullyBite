'use client';

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

const TH_CLS = 'py-2 px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';

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
          <div className="cb p-8 text-center text-dim">
            Super admin access required.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="pg-admins">
      <div className="card">
        <div className="ch justify-between">
          <h3 className="m-0">Admin Users</h3>
          <span className="text-dim text-[0.78rem]">Only super admins see this page.</span>
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink text-left text-dim text-[0.74rem]">
                  <th className={TH_CLS}>Name</th>
                  <th className={TH_CLS}>Email</th>
                  <th className={TH_CLS}>Role</th>
                  <th className={TH_CLS}>Active</th>
                  <th className={TH_CLS}>Can view full phone numbers</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={5} className={EMPTY_CLS}>No admin users yet.</td></tr>
                ) : rows.map((u) => {
                  const canSee = !!(u.permissions && u.permissions.customer_full_phone) || u.role === 'super_admin';
                  const lockedSuper = u.role === 'super_admin';
                  return (
                    <tr key={u.id} className="border-t border-rim">
                      <td className={TD_CLS}>{u.name || '—'}</td>
                      <td className={TD_CLS}>{u.email || ''}</td>
                      <td className={TD_CLS}>{u.role || 'admin'}</td>
                      <td className={TD_CLS}>{u.is_active === false ? <span className="text-red-600">disabled</span> : 'yes'}</td>
                      <td className={TD_CLS}>
                        <label title="Can view full customer phone numbers" className="inline-flex items-center gap-[0.4rem] text-[0.78rem]">
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
