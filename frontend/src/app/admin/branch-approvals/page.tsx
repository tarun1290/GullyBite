'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getAdminBranches,
  approveBranch,
  bulkApproveBranches,
} from '../../../api/admin';

interface AdminBranchRow {
  id: string;
  name?: string;
  branch_slug?: string;
  restaurant_id?: string;
  business_name?: string;
  subscription_status?: string;
  created_at?: string;
}

interface BulkApproveResult {
  approved?: string[];
  skipped?: string[];
  failed?: { branch_id: string; error: string }[];
}

function fmtDateTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

const TH_CLS = 'py-2.5 px-3 text-left text-xs text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-3 align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';

export default function AdminBranchApprovalsPage() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<AdminBranchRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<boolean>(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      // GET /api/admin/branches can only filter by restaurant_id, so fetch
      // all branches and narrow to the pending_approval subscription state
      // client-side.
      const all = (await getAdminBranches('')) as AdminBranchRow[] | null;
      const pending = (Array.isArray(all) ? all : []).filter(
        (b) => b.subscription_status === 'pending_approval',
      );
      setRows(pending);
      setSelected({});
      setListErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setListErr(er?.response?.data?.error || er?.message || 'Failed to load branches');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const selectedIds = useMemo(
    () => rows.filter((r) => selected[r.id]).map((r) => r.id),
    [rows, selected],
  );

  const allSelected = rows.length > 0 && selectedIds.length === rows.length;

  const toggleAll = () => {
    if (allSelected) {
      setSelected({});
    } else {
      const next: Record<string, boolean> = {};
      rows.forEach((r) => { next[r.id] = true; });
      setSelected(next);
    }
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const doApprove = async (id: string) => {
    setBusy(true);
    try {
      await approveBranch(id);
      showToast('Branch approved', 'success');
      await loadList();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Approve failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const doBulkApprove = async () => {
    if (selectedIds.length === 0) return;
    setBusy(true);
    try {
      const res = (await bulkApproveBranches(selectedIds)) as BulkApproveResult | null;
      const approved = res?.approved?.length || 0;
      const skipped = res?.skipped?.length || 0;
      const failed = res?.failed?.length || 0;
      const parts = [`${approved} approved`];
      if (skipped) parts.push(`${skipped} skipped`);
      if (failed) parts.push(`${failed} failed`);
      showToast(parts.join(' · '), failed ? 'warning' : 'success');
      await loadList();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Bulk approve failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="pg-branch-approvals">
      <div className="card">
        <div className="ch justify-between flex-wrap gap-2">
          <h3 className="m-0">Pending Approval</h3>
          <span className="text-dim text-xs">{rows.length} pending</span>
          <div className="ml-auto flex gap-2 flex-wrap">
            <button
              type="button"
              className="btn-p btn-sm"
              onClick={doBulkApprove}
              disabled={busy || selectedIds.length === 0}
            >
              Approve Selected ({selectedIds.length})
            </button>
            <button
              type="button"
              className="btn-g btn-sm"
              onClick={loadList}
              disabled={loading || busy}
            >
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
        </div>
        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadList} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={`${TH_CLS} w-10`}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Select all"
                      disabled={rows.length === 0}
                    />
                  </th>
                  <th className={TH_CLS}>Branch</th>
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Created</th>
                  <th className={TH_CLS}></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={5} className={EMPTY_CLS}>No branches awaiting approval.</td></tr>
                ) : rows.map((b) => (
                  <tr key={b.id} className="border-b border-rim">
                    <td className={TD_CLS}>
                      <input
                        type="checkbox"
                        checked={!!selected[b.id]}
                        onChange={() => toggleOne(b.id)}
                        aria-label={`Select ${b.name || b.id}`}
                      />
                    </td>
                    <td className={TD_CLS}>
                      <strong>{b.name || b.branch_slug || '—'}</strong>
                      <div className="text-xs text-dim mono">{String(b.id).slice(0, 8)}</div>
                    </td>
                    <td className={TD_CLS}>
                      {b.business_name || '—'}
                      <div className="text-xs text-dim mono">
                        {String(b.restaurant_id || '').slice(0, 8)}
                      </div>
                    </td>
                    <td className={`${TD_CLS} text-dim text-xs whitespace-nowrap`}>
                      {fmtDateTime(b.created_at)}
                    </td>
                    <td className={TD_CLS}>
                      <button
                        type="button"
                        className="btn-p btn-sm py-1 px-2 text-xs"
                        onClick={() => doApprove(b.id)}
                        disabled={busy}
                      >
                        Approve
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
