'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  approveApplication,
  getApplications,
  rejectApplication,
  verifyApplicationFssai,
  verifyApplicationGst,
} from '../../../api/admin';

const TYPE_LABEL: Record<string, string> = { veg: 'Pure Veg', non_veg: 'Non-Veg', both: 'Veg & Non-Veg' };

interface ApplicationRow {
  id: string;
  brand_name?: string;
  business_name?: string;
  registered_business_name?: string;
  store_url?: string;
  owner_name?: string;
  phone?: string;
  email?: string;
  gst_number?: string;
  gst_verified?: boolean;
  fssai_license?: string;
  fssai_expiry?: string;
  fssai_verified?: boolean;
  restaurant_type?: string;
  submitted_at?: string;
  approval_status?: string;
  approval_notes?: string;
}

interface PendingAction {
  id: string;
  action: 'approve' | 'reject';
  name: string;
}

const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.6rem] px-[0.7rem] align-top';
const SUB_CLS = 'text-[0.72rem] text-dim';
const EMPTY_CLS = 'p-6 text-center text-dim';

interface StatusBadgeProps { status?: string }

function StatusBadge({ status }: StatusBadgeProps) {
  const COMMON = 'text-[0.68rem] font-bold py-[0.12rem] px-[0.45rem] rounded-md uppercase tracking-[0.03em] text-neutral-0';
  if (status === 'approved')
    return <span className={`${COMMON} bg-wa-500`}>Approved</span>;
  if (status === 'rejected')
    return <span className={`${COMMON} bg-red-500`}>Rejected</span>;
  return <span className={`${COMMON} bg-amber-500`}>Pending</span>;
}

interface VerifiedPillProps { verified?: boolean }

function VerifiedPill({ verified }: VerifiedPillProps) {
  if (verified) {
    return (
      <span className="text-[0.66rem] text-wa-500 font-bold">
        ✓ Verified
      </span>
    );
  }
  return null;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-IN'); } catch { return '—'; }
}

export default function AdminApplicationsPage() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<ApplicationRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notes, setNotes] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = (await getApplications()) as ApplicationRow[] | null;
      setRows(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed to load applications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const pendingCount = useMemo<number>(
    () => rows.filter((r) => r.approval_status === 'pending').length,
    [rows],
  );

  const openConfirm = (r: ApplicationRow, action: 'approve' | 'reject') => {
    setPending({ id: r.id, action, name: r.brand_name || r.business_name || '' });
    setNotes('');
  };
  const cancelConfirm = () => { setPending(null); setNotes(''); };

  const doConfirm = async () => {
    if (!pending) return;
    const { id, action } = pending;
    if (action === 'reject' && !notes.trim()) {
      showToast('Please provide a rejection reason', 'error');
      return;
    }
    setRowBusy(id);
    try {
      if (action === 'approve') await approveApplication(id, notes.trim());
      else await rejectApplication(id, notes.trim());
      showToast(`Restaurant ${action === 'approve' ? 'approved' : 'rejected'} successfully`, 'success');
      cancelConfirm();
      await load();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Action failed', 'error');
    } finally {
      setRowBusy(null);
    }
  };

  const doVerify = async (r: ApplicationRow, type: 'gst' | 'fssai') => {
    setRowBusy(r.id);
    try {
      if (type === 'gst') await verifyApplicationGst(r.id, true);
      else await verifyApplicationFssai(r.id, true);
      showToast(`${type.toUpperCase()} verified`, 'success');
      await load();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Verify failed', 'error');
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <div id="pg-applications">
      <div className="card">
        <div className="ch gap-[0.6rem] flex-wrap">
          <h3>Restaurant Applications</h3>
          <span className="text-dim text-[0.75rem]">
            {loading ? '' : `${rows.length} record(s)${pendingCount ? ` · ${pendingCount} pending` : ''}`}
          </span>
          <button
            type="button"
            className="btn-g btn-sm ml-auto"
            onClick={load}
            disabled={loading}
          >
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>

        {err ? (
          <div className="cb">
            <SectionError message={err} onRetry={load} />
          </div>
        ) : (
          <div className="cb overflow-x-auto p-0">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={TH_CLS}>Brand / Business</th>
                  <th className={TH_CLS}>Contact</th>
                  <th className={TH_CLS}>GST</th>
                  <th className={TH_CLS}>FSSAI</th>
                  <th className={TH_CLS}>Type</th>
                  <th className={TH_CLS}>Submitted</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8} className={EMPTY_CLS}>No applications</td></tr>
                ) : (
                  rows.map((r) => {
                    const isPendingRow = pending?.id === r.id;
                    const busy = rowBusy === r.id;
                    return (
                      <Fragment key={r.id}>
                        <tr className="border-b border-rim">
                          <td className={TD_CLS}>
                            <strong>{r.brand_name || r.business_name || '—'}</strong>
                            {r.registered_business_name && (
                              <div className={SUB_CLS}>{r.registered_business_name}</div>
                            )}
                            {r.store_url && (
                              <a
                                href={r.store_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[0.72rem] text-acc"
                              >Store ↗</a>
                            )}
                          </td>
                          <td className={TD_CLS}>
                            <div>{r.owner_name || '—'}</div>
                            <div className={SUB_CLS}>{r.phone || ''}</div>
                            <div className={SUB_CLS}>{r.email || ''}</div>
                          </td>
                          <td className={TD_CLS}>
                            {r.gst_number ? (
                              <>
                                <div className="text-[0.8rem]">{r.gst_number}</div>
                                {r.gst_verified ? (
                                  <VerifiedPill verified />
                                ) : (
                                  <button
                                    type="button"
                                    className="btn-p btn-sm text-[0.66rem] py-[0.18rem] px-2 mt-[0.2rem]"
                                    disabled={busy}
                                    onClick={() => doVerify(r, 'gst')}
                                  >Verify</button>
                                )}
                              </>
                            ) : (
                              <span className="text-dim">—</span>
                            )}
                          </td>
                          <td className={TD_CLS}>
                            {r.fssai_license ? (
                              <>
                                <div className="text-[0.8rem]">{r.fssai_license}</div>
                                <div className={SUB_CLS}>Exp: {fmtDate(r.fssai_expiry)}</div>
                                {r.fssai_verified ? (
                                  <VerifiedPill verified />
                                ) : (
                                  <button
                                    type="button"
                                    className="btn-p btn-sm text-[0.66rem] py-[0.18rem] px-2 mt-[0.2rem]"
                                    disabled={busy}
                                    onClick={() => doVerify(r, 'fssai')}
                                  >Verify</button>
                                )}
                              </>
                            ) : (
                              <span className="text-dim">—</span>
                            )}
                          </td>
                          <td className={TD_CLS}>{TYPE_LABEL[r.restaurant_type || ''] || '—'}</td>
                          <td className={TD_CLS}>{fmtDate(r.submitted_at)}</td>
                          <td className={TD_CLS}>
                            <StatusBadge status={r.approval_status} />
                            {r.approval_notes && (
                              <div className={SUB_CLS}>{r.approval_notes}</div>
                            )}
                          </td>
                          <td className={TD_CLS}>
                            {r.approval_status === 'pending' ? (
                              <>
                                <button
                                  type="button"
                                  className="btn-p btn-sm text-[0.72rem]"
                                  disabled={busy}
                                  onClick={() => openConfirm(r, 'approve')}
                                >Approve</button>
                                <button
                                  type="button"
                                  className="btn-del btn-sm ml-[0.3rem]"
                                  disabled={busy}
                                  onClick={() => openConfirm(r, 'reject')}
                                >Reject</button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn-g btn-sm text-[0.72rem]"
                                disabled={busy}
                                onClick={() => openConfirm(r, 'approve')}
                              >Re-approve</button>
                            )}
                          </td>
                        </tr>
                        {isPendingRow && pending && (
                          <tr>
                            <td colSpan={8} className="bg-ink3 py-[0.9rem] px-4">
                              <div className="font-semibold mb-[0.4rem]">
                                {pending.action === 'approve'
                                  ? `Approve "${pending.name}"?`
                                  : `Reject "${pending.name}"?`}
                              </div>
                              <label className="text-[0.74rem] text-dim block mb-[0.3rem]">
                                {pending.action === 'approve'
                                  ? 'Notes (optional)'
                                  : 'Rejection reason (required)'}
                              </label>
                              <textarea
                                rows={3}
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                placeholder={
                                  pending.action === 'approve'
                                    ? 'Welcome message or any notes…'
                                    : 'e.g. GST number invalid, FSSAI expired…'
                                }
                                className="w-full py-2 px-[0.7rem] border border-rim rounded-md text-[0.82rem] font-[inherit] resize-y"
                              />
                              <div className="mt-[0.6rem] flex gap-2 justify-end">
                                <button
                                  type="button"
                                  className="btn-g btn-sm"
                                  onClick={cancelConfirm}
                                  disabled={busy}
                                >Cancel</button>
                                <button
                                  type="button"
                                  className={pending.action === 'approve' ? 'btn-p btn-sm' : 'btn-sm bg-red-500 text-neutral-0'}
                                  onClick={doConfirm}
                                  disabled={busy}
                                >
                                  {busy ? 'Working…' : pending.action === 'approve' ? 'Approve' : 'Reject'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
