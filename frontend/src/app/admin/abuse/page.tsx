'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/dashboard/analytics/SectionError';
import {
  getRateLimitStats,
  getBlockedPhones,
  blockPhone,
  unblockPhone,
} from '../../../api/admin';

interface TopRateRow { phone: string; count: number }

interface RateLimitStatsData {
  rate_limited_today?: number;
  auto_blocked_today?: number;
  active_blocks?: number;
  top_rate_limited?: TopRateRow[];
}

interface BlockedRow {
  id: string;
  wa_phone?: string;
  reason?: string;
  blocked_by?: string;
  blocked_at?: string;
  expires_at?: string;
  is_active?: boolean;
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

const th: CSSProperties = { padding: '.5rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.5rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input: CSSProperties = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.45rem .7rem', fontSize: '.85rem' };
const lbl: CSSProperties = { fontSize: '.78rem', color: 'var(--dim)', display: 'block', marginBottom: '.3rem' };

export default function AdminAbusePage() {
  const { showToast } = useToast();
  const [stats, setStats] = useState<RateLimitStatsData | null>(null);
  const [topRows, setTopRows] = useState<TopRateRow[]>([]);
  const [blocked, setBlocked] = useState<BlockedRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [blockedErr, setBlockedErr] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [fPhone, setFPhone] = useState<string>('');
  const [fReason, setFReason] = useState<string>('');
  const [fDuration, setFDuration] = useState<string>('24');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [confirmUnblock, setConfirmUnblock] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const d = (await getRateLimitStats()) as RateLimitStatsData | null;
      setStats(d);
      setTopRows(d?.top_rate_limited || []);
      setStatsErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setStatsErr(er?.response?.data?.error || er?.message || 'Failed to load stats');
    }
  }, []);

  const loadBlocked = useCallback(async () => {
    setLoading(true);
    try {
      const d = (await getBlockedPhones()) as BlockedRow[] | null;
      setBlocked(Array.isArray(d) ? d : []);
      setBlockedErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setBlocked([]);
      setBlockedErr(er?.response?.data?.error || er?.message || 'Failed to load blocked phones');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStats(); loadBlocked(); }, [loadStats, loadBlocked]);

  const openBlock = (prefillPhone = '', prefillReason = '') => {
    setFPhone(prefillPhone);
    setFReason(prefillReason);
    setFDuration('24');
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setFPhone(''); setFReason(''); setFDuration('24');
  };

  const submitBlock = async () => {
    const wa_phone = fPhone.trim();
    if (!wa_phone) {
      showToast('Phone number is required', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await blockPhone({
        wa_phone,
        reason: fReason.trim(),
        durationHours: fDuration ? parseInt(fDuration, 10) : null,
      });
      showToast('Phone blocked', 'success');
      closeModal();
      await Promise.all([loadStats(), loadBlocked()]);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Block failed', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const doUnblock = async (id: string) => {
    setBusyId(id);
    try {
      await unblockPhone(id);
      showToast('Phone unblocked', 'success');
      setConfirmUnblock(null);
      await Promise.all([loadStats(), loadBlocked()]);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Unblock failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div id="pg-abuse">
      <div className="stats" style={{ marginBottom: '1rem' }}>
        <StatCard label="Rate Limited Today" value={stats?.rate_limited_today ?? 0} />
        <StatCard label="Auto-Blocked Today" value={stats?.auto_blocked_today ?? 0} />
        <StatCard label="Active Blocks" value={stats?.active_blocks ?? 0} />
      </div>
      {statsErr && <div style={{ marginBottom: '1rem' }}><SectionError message={statsErr} onRetry={loadStats} /></div>}

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch"><h3 style={{ margin: 0 }}>Top Rate-Limited Phones (Today)</h3></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
            <thead>
              <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                <th style={th}>Phone</th>
                <th style={th}>Hits</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {topRows.length === 0 ? (
                <tr><td colSpan={3} style={emptyCell}>No rate-limited phones today.</td></tr>
              ) : topRows.map((p, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--rim)' }}>
                  <td style={td} className="mono">{p.phone}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{p.count}</td>
                  <td style={td}>
                    <button
                      type="button"
                      className="btn-g btn-sm"
                      style={{ background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)' }}
                      onClick={() => openBlock(p.phone, 'Excessive rate-limit violations')}
                    >Block</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Blocked Phones</h3>
          <button
            type="button"
            className="btn-p btn-sm"
            style={{ background: 'var(--gb-red-500)' }}
            onClick={() => openBlock()}
          >+ Block Phone</button>
        </div>

        {blockedErr ? (
          <div className="cb"><SectionError message={blockedErr} onRetry={loadBlocked} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                  <th style={th}>Phone</th>
                  <th style={th}>Reason</th>
                  <th style={th}>Blocked By</th>
                  <th style={th}>Blocked At</th>
                  <th style={th}>Expires</th>
                  <th style={th}>Status</th>
                  <th style={th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} style={emptyCell}>Loading…</td></tr>
                ) : blocked.length === 0 ? (
                  <tr><td colSpan={7} style={emptyCell}>No blocked phones.</td></tr>
                ) : blocked.map((b) => (
                  <tr key={b.id} style={{ borderTop: '1px solid var(--rim)' }}>
                    <td style={td} className="mono">{b.wa_phone}</td>
                    <td style={{ ...td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.reason || ''}>{b.reason || '—'}</td>
                    <td style={td}>
                      <span style={{
                        display: 'inline-block', padding: '.1rem .45rem', borderRadius: 10,
                        fontSize: '.7rem', fontWeight: 600,
                        background: b.blocked_by === 'auto' ? 'rgba(245,158,11,.18)' : 'rgba(59,130,246,.18)',
                        color: b.blocked_by === 'auto' ? 'var(--gb-amber-600)' : 'var(--gb-blue-600)',
                      }}>{b.blocked_by === 'auto' ? 'Auto' : 'Admin'}</span>
                    </td>
                    <td style={{ ...td, fontSize: '.75rem', color: 'var(--dim)' }}>{fmtTime(b.blocked_at)}</td>
                    <td style={{ ...td, fontSize: '.75rem' }}>{b.expires_at ? fmtTime(b.expires_at) : <span style={{ color: 'var(--gb-red-600)' }}>Never</span>}</td>
                    <td style={td}>
                      <span style={{
                        display: 'inline-block', padding: '.1rem .45rem', borderRadius: 10,
                        fontSize: '.7rem', fontWeight: 600,
                        background: b.is_active ? 'rgba(239,68,68,.18)' : 'rgba(100,116,139,.18)',
                        color: b.is_active ? 'var(--gb-red-600)' : 'var(--gb-slate-700)',
                      }}>{b.is_active ? 'Active' : 'Expired'}</span>
                    </td>
                    <td style={td}>
                      {confirmUnblock === b.id ? (
                        <>
                          <button type="button" className="btn-g btn-sm" style={{ background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)', marginRight: '.3rem' }} onClick={() => doUnblock(b.id)} disabled={busyId === b.id}>Confirm</button>
                          <button type="button" className="btn-g btn-sm" onClick={() => setConfirmUnblock(null)}>Cancel</button>
                        </>
                      ) : (
                        <button type="button" className="btn-g btn-sm" onClick={() => setConfirmUnblock(b.id)}>Unblock</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalOpen && (
        <div
          onClick={closeModal}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--gb-neutral-0)', borderRadius: 10, width: '100%', maxWidth: 420 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '.8rem 1rem', borderBottom: '1px solid var(--rim)' }}>
              <h3 style={{ margin: 0, fontSize: '.95rem' }}>Block Phone Number</h3>
              <button type="button" className="btn-g btn-sm" onClick={closeModal}>✕</button>
            </div>
            <div style={{ padding: '1rem' }}>
              <div style={{ marginBottom: '.8rem' }}>
                <label style={lbl}>WhatsApp Phone Number</label>
                <input
                  value={fPhone}
                  onChange={(e) => setFPhone(e.target.value)}
                  placeholder="919876543210"
                  style={{ ...input, width: '100%' }}
                />
                <span style={{ fontSize: '.7rem', color: 'var(--dim)' }}>Country code + number, no + prefix</span>
              </div>
              <div style={{ marginBottom: '.8rem' }}>
                <label style={lbl}>Reason</label>
                <input
                  value={fReason}
                  onChange={(e) => setFReason(e.target.value)}
                  placeholder="Spam, abuse, etc."
                  style={{ ...input, width: '100%' }}
                />
              </div>
              <div style={{ marginBottom: '1rem' }}>
                <label style={lbl}>Duration</label>
                <select value={fDuration} onChange={(e) => setFDuration(e.target.value)} style={{ ...input, width: '100%' }}>
                  <option value="1">1 hour</option>
                  <option value="24">24 hours</option>
                  <option value="168">7 days</option>
                  <option value="">Permanent</option>
                </select>
              </div>
              <button
                type="button"
                onClick={submitBlock}
                disabled={submitting}
                style={{
                  width: '100%', background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)', border: 'none',
                  borderRadius: 6, padding: '.55rem', fontSize: '.88rem', fontWeight: 600, cursor: 'pointer',
                }}
              >{submitting ? 'Blocking…' : 'Block Phone'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
