'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
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

const TH_CLS = 'py-2 px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.45rem] px-[0.7rem] text-[0.85rem]';
const LBL_CLS = 'text-[0.78rem] text-dim block mb-[0.3rem]';

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
      <div className="stats mb-4">
        <StatCard label="Rate Limited Today" value={stats?.rate_limited_today ?? 0} />
        <StatCard label="Auto-Blocked Today" value={stats?.auto_blocked_today ?? 0} />
        <StatCard label="Active Blocks" value={stats?.active_blocks ?? 0} />
      </div>
      {statsErr && <div className="mb-4"><SectionError message={statsErr} onRetry={loadStats} /></div>}

      <div className="card mb-4">
        <div className="ch"><h3 className="m-0">Top Rate-Limited Phones (Today)</h3></div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.82rem]">
            <thead>
              <tr className="bg-ink text-left text-dim text-[0.74rem]">
                <th className={TH_CLS}>Phone</th>
                <th className={TH_CLS}>Hits</th>
                <th className={TH_CLS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {topRows.length === 0 ? (
                <tr><td colSpan={3} className={EMPTY_CLS}>No rate-limited phones today.</td></tr>
              ) : topRows.map((p, i) => (
                <tr key={i} className="border-t border-rim">
                  <td className={`${TD_CLS} mono`}>{p.phone}</td>
                  <td className={`${TD_CLS} font-semibold`}>{p.count}</td>
                  <td className={TD_CLS}>
                    <button
                      type="button"
                      className="btn-g btn-sm bg-red-500 text-neutral-0"
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
        <div className="ch justify-between">
          <h3 className="m-0">Blocked Phones</h3>
          <button
            type="button"
            className="btn-p btn-sm bg-red-500"
            onClick={() => openBlock()}
          >+ Block Phone</button>
        </div>

        {blockedErr ? (
          <div className="cb"><SectionError message={blockedErr} onRetry={loadBlocked} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink text-left text-dim text-[0.74rem]">
                  <th className={TH_CLS}>Phone</th>
                  <th className={TH_CLS}>Reason</th>
                  <th className={TH_CLS}>Blocked By</th>
                  <th className={TH_CLS}>Blocked At</th>
                  <th className={TH_CLS}>Expires</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>Loading…</td></tr>
                ) : blocked.length === 0 ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>No blocked phones.</td></tr>
                ) : blocked.map((b) => {
                  const byCls = b.blocked_by === 'auto'
                    ? 'bg-[rgba(245,158,11,0.18)] text-amber-600'
                    : 'bg-[rgba(59,130,246,0.18)] text-blue-600';
                  const stCls = b.is_active
                    ? 'bg-[rgba(239,68,68,0.18)] text-red-600'
                    : 'bg-[rgba(100,116,139,0.18)] text-slate-700';
                  return (
                  <tr key={b.id} className="border-t border-rim">
                    <td className={`${TD_CLS} mono`}>{b.wa_phone}</td>
                    <td className={`${TD_CLS} max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap`} title={b.reason || ''}>{b.reason || '—'}</td>
                    <td className={TD_CLS}>
                      <span className={`inline-block py-[0.1rem] px-[0.45rem] rounded-[10px] text-[0.7rem] font-semibold ${byCls}`}>{b.blocked_by === 'auto' ? 'Auto' : 'Admin'}</span>
                    </td>
                    <td className={`${TD_CLS} text-[0.75rem] text-dim`}>{fmtTime(b.blocked_at)}</td>
                    <td className={`${TD_CLS} text-[0.75rem]`}>{b.expires_at ? fmtTime(b.expires_at) : <span className="text-red-600">Never</span>}</td>
                    <td className={TD_CLS}>
                      <span className={`inline-block py-[0.1rem] px-[0.45rem] rounded-[10px] text-[0.7rem] font-semibold ${stCls}`}>{b.is_active ? 'Active' : 'Expired'}</span>
                    </td>
                    <td className={TD_CLS}>
                      {confirmUnblock === b.id ? (
                        <>
                          <button type="button" className="btn-g btn-sm bg-red-500 text-neutral-0 mr-[0.3rem]" onClick={() => doUnblock(b.id)} disabled={busyId === b.id}>Confirm</button>
                          <button type="button" className="btn-g btn-sm" onClick={() => setConfirmUnblock(null)}>Cancel</button>
                        </>
                      ) : (
                        <button type="button" className="btn-g btn-sm" onClick={() => setConfirmUnblock(b.id)}>Unblock</button>
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

      {modalOpen && (
        <div
          onClick={closeModal}
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-neutral-0 rounded-[10px] w-full max-w-[420px]"
          >
            <div className="flex items-center justify-between py-[0.8rem] px-4 border-b border-rim">
              <h3 className="m-0 text-[0.95rem]">Block Phone Number</h3>
              <button type="button" className="btn-g btn-sm" onClick={closeModal}>✕</button>
            </div>
            <div className="p-4">
              <div className="mb-[0.8rem]">
                <label className={LBL_CLS}>WhatsApp Phone Number</label>
                <input
                  value={fPhone}
                  onChange={(e) => setFPhone(e.target.value)}
                  placeholder="919876543210"
                  className={`${INPUT_CLS} w-full`}
                />
                <span className="text-[0.7rem] text-dim">Country code + number, no + prefix</span>
              </div>
              <div className="mb-[0.8rem]">
                <label className={LBL_CLS}>Reason</label>
                <input
                  value={fReason}
                  onChange={(e) => setFReason(e.target.value)}
                  placeholder="Spam, abuse, etc."
                  className={`${INPUT_CLS} w-full`}
                />
              </div>
              <div className="mb-4">
                <label className={LBL_CLS}>Duration</label>
                <select value={fDuration} onChange={(e) => setFDuration(e.target.value)} className={`${INPUT_CLS} w-full`}>
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
                className="w-full bg-red-500 text-neutral-0 border-0 rounded-md py-[0.55rem] text-[0.88rem] font-semibold cursor-pointer"
              >{submitting ? 'Blocking…' : 'Block Phone'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
