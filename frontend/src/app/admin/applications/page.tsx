'use client';

import type { CSSProperties } from 'react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/dashboard/analytics/SectionError';
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

const th: CSSProperties = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.6rem .7rem', verticalAlign: 'top' };
const sub: CSSProperties = { fontSize: '.72rem', color: 'var(--dim)' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };

interface StatusBadgeProps { status?: string }

function StatusBadge({ status }: StatusBadgeProps) {
  const common: CSSProperties = {
    fontSize: '.68rem',
    fontWeight: 700,
    padding: '.12rem .45rem',
    borderRadius: 6,
    textTransform: 'uppercase',
    letterSpacing: '.03em',
    color: 'var(--gb-neutral-0)',
  };
  if (status === 'approved')
    return <span style={{ ...common, background: 'var(--gb-wa-500)' }}>Approved</span>;
  if (status === 'rejected')
    return <span style={{ ...common, background: 'var(--gb-red-500)' }}>Rejected</span>;
  return <span style={{ ...common, background: 'var(--gb-amber-500)' }}>Pending</span>;
}

interface VerifiedPillProps { verified?: boolean }

function VerifiedPill({ verified }: VerifiedPillProps) {
  if (verified) {
    return (
      <span style={{ fontSize: '.66rem', color: 'var(--gb-wa-500)', fontWeight: 700 }}>
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
        <div className="ch" style={{ gap: '.6rem', flexWrap: 'wrap' }}>
          <h3>Restaurant Applications</h3>
          <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>
            {loading ? '' : `${rows.length} record(s)${pendingCount ? ` · ${pendingCount} pending` : ''}`}
          </span>
          <button
            type="button"
            className="btn-g btn-sm"
            style={{ marginLeft: 'auto' }}
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
          <div className="cb" style={{ overflowX: 'auto', padding: 0 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', borderBottom: '1px solid var(--rim)' }}>
                  <th style={th}>Brand / Business</th>
                  <th style={th}>Contact</th>
                  <th style={th}>GST</th>
                  <th style={th}>FSSAI</th>
                  <th style={th}>Type</th>
                  <th style={th}>Submitted</th>
                  <th style={th}>Status</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8} style={emptyCell}>No applications</td></tr>
                ) : (
                  rows.map((r) => {
                    const isPendingRow = pending?.id === r.id;
                    const busy = rowBusy === r.id;
                    return (
                      <Fragment key={r.id}>
                        <tr style={{ borderBottom: '1px solid var(--rim)' }}>
                          <td style={td}>
                            <strong>{r.brand_name || r.business_name || '—'}</strong>
                            {r.registered_business_name && (
                              <div style={sub}>{r.registered_business_name}</div>
                            )}
                            {r.store_url && (
                              <a
                                href={r.store_url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ fontSize: '.72rem', color: 'var(--acc)' }}
                              >Store ↗</a>
                            )}
                          </td>
                          <td style={td}>
                            <div>{r.owner_name || '—'}</div>
                            <div style={sub}>{r.phone || ''}</div>
                            <div style={sub}>{r.email || ''}</div>
                          </td>
                          <td style={td}>
                            {r.gst_number ? (
                              <>
                                <div style={{ fontSize: '.8rem' }}>{r.gst_number}</div>
                                {r.gst_verified ? (
                                  <VerifiedPill verified />
                                ) : (
                                  <button
                                    type="button"
                                    className="btn-p btn-sm"
                                    style={{ fontSize: '.66rem', padding: '.18rem .5rem', marginTop: '.2rem' }}
                                    disabled={busy}
                                    onClick={() => doVerify(r, 'gst')}
                                  >Verify</button>
                                )}
                              </>
                            ) : (
                              <span style={{ color: 'var(--dim)' }}>—</span>
                            )}
                          </td>
                          <td style={td}>
                            {r.fssai_license ? (
                              <>
                                <div style={{ fontSize: '.8rem' }}>{r.fssai_license}</div>
                                <div style={sub}>Exp: {fmtDate(r.fssai_expiry)}</div>
                                {r.fssai_verified ? (
                                  <VerifiedPill verified />
                                ) : (
                                  <button
                                    type="button"
                                    className="btn-p btn-sm"
                                    style={{ fontSize: '.66rem', padding: '.18rem .5rem', marginTop: '.2rem' }}
                                    disabled={busy}
                                    onClick={() => doVerify(r, 'fssai')}
                                  >Verify</button>
                                )}
                              </>
                            ) : (
                              <span style={{ color: 'var(--dim)' }}>—</span>
                            )}
                          </td>
                          <td style={td}>{TYPE_LABEL[r.restaurant_type || ''] || '—'}</td>
                          <td style={td}>{fmtDate(r.submitted_at)}</td>
                          <td style={td}>
                            <StatusBadge status={r.approval_status} />
                            {r.approval_notes && (
                              <div style={sub}>{r.approval_notes}</div>
                            )}
                          </td>
                          <td style={td}>
                            {r.approval_status === 'pending' ? (
                              <>
                                <button
                                  type="button"
                                  className="btn-p btn-sm"
                                  style={{ fontSize: '.72rem' }}
                                  disabled={busy}
                                  onClick={() => openConfirm(r, 'approve')}
                                >Approve</button>
                                <button
                                  type="button"
                                  className="btn-sm"
                                  style={{ fontSize: '.72rem', color: 'var(--gb-red-500)', marginLeft: '.3rem' }}
                                  disabled={busy}
                                  onClick={() => openConfirm(r, 'reject')}
                                >Reject</button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn-g btn-sm"
                                style={{ fontSize: '.72rem' }}
                                disabled={busy}
                                onClick={() => openConfirm(r, 'approve')}
                              >Re-approve</button>
                            )}
                          </td>
                        </tr>
                        {isPendingRow && pending && (
                          <tr>
                            <td colSpan={8} style={{ background: 'var(--ink3)', padding: '.9rem 1rem' }}>
                              <div style={{ fontWeight: 600, marginBottom: '.4rem' }}>
                                {pending.action === 'approve'
                                  ? `Approve "${pending.name}"?`
                                  : `Reject "${pending.name}"?`}
                              </div>
                              <label style={{ fontSize: '.74rem', color: 'var(--dim)', display: 'block', marginBottom: '.3rem' }}>
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
                                style={{
                                  width: '100%',
                                  padding: '.5rem .7rem',
                                  border: '1px solid var(--rim)',
                                  borderRadius: 6,
                                  fontSize: '.82rem',
                                  fontFamily: 'inherit',
                                  resize: 'vertical',
                                }}
                              />
                              <div style={{ marginTop: '.6rem', display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
                                <button
                                  type="button"
                                  className="btn-g btn-sm"
                                  onClick={cancelConfirm}
                                  disabled={busy}
                                >Cancel</button>
                                <button
                                  type="button"
                                  className={pending.action === 'approve' ? 'btn-p btn-sm' : 'btn-sm'}
                                  style={pending.action === 'reject'
                                    ? { background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)' }
                                    : undefined}
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
