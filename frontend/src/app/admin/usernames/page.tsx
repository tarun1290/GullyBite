'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getUsernames,
  checkUsername,
  setUsernameTarget,
  confirmUsername,
  syncUsername,
  releaseUsername,
  suggestUsernames,
  autoSuggestUsernamesAll,
  syncUsernamesAll,
} from '../../../api/admin';

interface StatusCfg { bg: string; fg: string }

const STATUS_COLORS: Record<string, StatusCfg> = {
  active:        { bg: 'rgba(34,197,94,.12)',  fg: '#047857' },
  pending_claim: { bg: 'rgba(234,179,8,.15)',  fg: '#a16207' },
  suggested:     { bg: 'rgba(59,130,246,.12)', fg: 'var(--gb-blue-600)' },
  not_claimed:   { bg: 'rgba(148,163,184,.18)', fg: 'var(--gb-slate-700)' },
  released:      { bg: 'rgba(239,68,68,.15)',  fg: 'var(--gb-red-600)' },
  rejected:      { bg: 'rgba(239,68,68,.15)',  fg: 'var(--gb-red-600)' },
};

interface UsernameRow {
  _id: string;
  restaurant_name?: string;
  city?: string;
  display_name?: string;
  business_username?: string;
  username_status?: string;
  username_suggestions?: string[];
  wa_phone_number?: string;
}

interface UsernamesEnvelope { items?: UsernameRow[] }

interface AutoSuggestResult { updated?: number; total?: number }
interface SyncAllResult { synced?: number; not_available?: number; failed?: number }
interface CheckResult { available?: boolean; error?: string }
interface SyncResult { synced?: boolean; username?: string; reason?: string }
interface SuggestResult { suggestions?: string[] }

function statusBadge(s?: string) {
  const cfg = STATUS_COLORS[s || ''] || STATUS_COLORS.not_claimed;
  return (
    // Dynamic: bg/fg come from a runtime palette map keyed by status.
    <span
      className="inline-block py-[0.1rem] px-2 rounded-[10px] text-[0.72rem] font-semibold"
      style={{ background: cfg?.bg, color: cfg?.fg }}
    >{(s || 'not_claimed').replace(/_/g, ' ')}</span>
  );
}

const TH_CLS = 'py-2 px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.45rem] px-[0.7rem] text-[0.85rem]';
const LBL_CLS = 'text-[0.78rem] text-dim block mb-[0.3rem]';

export default function AdminUsernamesPage() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<UsernameRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const [status, setStatus] = useState<string>('all');
  const [pendingSearch, setPendingSearch] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  const [busyBulk, setBusyBulk] = useState<boolean>(false);
  const [active, setActive] = useState<UsernameRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(pendingSearch), 350);
    return () => clearTimeout(t);
  }, [pendingSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string | number> = {};
    if (search) params.search = search;
    if (status && status !== 'all') params.status = status;
    try {
      const d = (await getUsernames(params)) as UsernameRow[] | UsernamesEnvelope | null;
      const list: UsernameRow[] = Array.isArray(d) ? d : (d?.items || []);
      setRows(list);
      setErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setErr(er?.response?.data?.error || er?.message || 'Failed to load usernames');
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => { load(); }, [load]);

  const doAutoSuggestAll = async () => {
    setBusyBulk(true);
    try {
      const r = (await autoSuggestUsernamesAll()) as AutoSuggestResult | null;
      showToast(`Suggestions generated for ${r?.updated ?? 0} / ${r?.total ?? 0} accounts`, 'success');
      load();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Auto-suggest failed', 'error');
    } finally {
      setBusyBulk(false);
    }
  };

  const doSyncAll = async () => {
    setBusyBulk(true);
    try {
      const r = (await syncUsernamesAll()) as SyncAllResult | null;
      showToast(`Sync: ${r?.synced ?? 0} synced, ${r?.not_available ?? 0} unavailable, ${r?.failed ?? 0} failed`, 'success');
      load();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Sync failed', 'error');
    } finally {
      setBusyBulk(false);
    }
  };

  return (
    <div id="pg-usernames">
      <div className="card">
        <div className="ch justify-between flex-wrap gap-2">
          <h3 className="m-0">Business Usernames</h3>
          <div className="flex gap-[0.4rem]">
            <button type="button" className="btn-p btn-sm" onClick={doAutoSuggestAll} disabled={busyBulk}>Auto-Suggest All</button>
            <button type="button" className="btn-g btn-sm" onClick={doSyncAll} disabled={busyBulk}>Sync All from Meta</button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 py-3 px-4 border-b border-rim">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={INPUT_CLS}>
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="pending_claim">Pending Claim</option>
            <option value="suggested">Suggested</option>
            <option value="not_claimed">Not Claimed</option>
            <option value="released">Released</option>
          </select>
          <input
            value={pendingSearch}
            onChange={(e) => setPendingSearch(e.target.value)}
            placeholder="Search restaurant or username…"
            className={`${INPUT_CLS} flex-1 max-w-[280px]`}
          />
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink text-left text-dim text-[0.74rem]">
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>WABA Display</th>
                  <th className={TH_CLS}>Username</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>wa.me Link</th>
                  <th className={TH_CLS}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} className={EMPTY_CLS}>No usernames found.</td></tr>
                ) : rows.map((u) => {
                  const waLink = (u.business_username && u.username_status === 'active')
                    ? `wa.me/${u.business_username}`
                    : u.wa_phone_number ? `wa.me/${u.wa_phone_number}` : '';
                  return (
                    <tr key={u._id} className="border-t border-rim">
                      <td className={TD_CLS}>
                        {u.restaurant_name || '—'}
                        {u.city && <><br /><span className="text-[0.72rem] text-dim">{u.city}</span></>}
                      </td>
                      <td className={TD_CLS}>{u.display_name || '—'}</td>
                      <td className={`${TD_CLS} mono`}>{u.business_username ? '@' + u.business_username : <span className="text-dim">—</span>}</td>
                      <td className={TD_CLS}>{statusBadge(u.username_status)}</td>
                      <td className={`${TD_CLS} text-[0.78rem]`}>
                        {waLink ? <a href={`https://${waLink}`} target="_blank" rel="noreferrer" className="text-acc">{waLink}</a> : '—'}
                      </td>
                      <td className={TD_CLS}><button type="button" className="btn-g btn-sm" onClick={() => setActive(u)}>Manage</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {active && (
        <UsernameModal
          account={active}
          onClose={() => setActive(null)}
          onReloadList={load}
          onReloadActive={async () => {
            try {
              const d = (await getUsernames({})) as UsernameRow[] | UsernamesEnvelope | null;
              const items: UsernameRow[] = Array.isArray(d) ? d : (d?.items || []);
              const fresh = items.find((x) => x._id === active._id);
              if (fresh) setActive(fresh);
              setRows(items);
            } catch { /* ignore */ }
          }}
        />
      )}
    </div>
  );
}

interface CheckState { status: string; error: string }

interface UsernameModalProps {
  account: UsernameRow;
  onClose: () => void;
  onReloadList: () => void;
  onReloadActive: () => Promise<void>;
}

function UsernameModal({ account: u, onClose, onReloadList, onReloadActive }: UsernameModalProps) {
  const { showToast } = useToast();
  const [custom, setCustom] = useState<string>('');
  const [checkState, setCheckState] = useState<CheckState>({ status: '', error: '' });
  const [canSet, setCanSet] = useState<boolean>(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showManual, setShowManual] = useState<boolean>(false);
  const [manual, setManual] = useState<string>('');
  const [confirmRelease, setConfirmRelease] = useState<boolean>(false);
  const [confirmConfirm, setConfirmConfirm] = useState<boolean>(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const waid = u._id;
  const isActive = u.username_status === 'active';
  const isPending = u.username_status === 'pending_claim';
  const suggestions = u.username_suggestions || [];

  const validate = (val: string) => {
    setCheckState({ status: '', error: '' });
    setCanSet(false);
    const v = val.trim().toLowerCase();
    if (!v) return;
    if (v.length < 5) {
      setCheckState({ status: '❌', error: 'Min 5 characters' });
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = (await checkUsername(waid, v)) as CheckResult | null;
        if (r?.available) {
          setCheckState({ status: '✅', error: '' });
          setCanSet(true);
        } else {
          setCheckState({ status: '❌', error: r?.error || 'Not available' });
          setCanSet(false);
        }
      } catch (e: unknown) {
        const er = e as { response?: { data?: { error?: string } }; message?: string };
        setCheckState({ status: '❌', error: er?.response?.data?.error || er?.message || 'Check failed' });
        setCanSet(false);
      }
    }, 400);
  };

  const onCustomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setCustom(v);
    validate(v);
  };

  const pickSuggestion = (s: string) => {
    setCustom(s);
    validate(s);
  };

  const setTarget = async () => {
    const v = custom.trim().toLowerCase();
    if (!v) return;
    setBusy('set');
    try {
      await setUsernameTarget(waid, v);
      showToast(`Target username set: @${v}`, 'success');
      onClose();
      onReloadList();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const doConfirm = async () => {
    if (!u.business_username) return;
    setBusy('confirm');
    try {
      await confirmUsername(waid, u.business_username);
      showToast(`@${u.business_username} is now active!`, 'success');
      onClose();
      onReloadList();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const doSync = async () => {
    setBusy('sync');
    try {
      const r = (await syncUsername(waid)) as SyncResult | null;
      if (r?.synced) {
        showToast(`Synced: @${r.username}`, 'success');
        onClose();
        onReloadList();
      } else {
        showToast(r?.reason || 'No username found on Meta', 'info');
        setShowManual(true);
      }
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Sync failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const doManualConfirm = async () => {
    const v = manual.trim().toLowerCase();
    if (!v) { showToast('Enter a username', 'error'); return; }
    setBusy('manual');
    try {
      await confirmUsername(waid, v);
      showToast(`Username @${v} confirmed!`, 'success');
      onClose();
      onReloadList();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const doRelease = async () => {
    setBusy('release');
    try {
      await releaseUsername(waid);
      showToast('Username released', 'success');
      onClose();
      onReloadList();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Release failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const doRegenerate = async () => {
    setBusy('suggest');
    try {
      const r = (await suggestUsernames(waid)) as SuggestResult | null;
      showToast(`Generated ${r?.suggestions?.length || 0} suggestions`, 'success');
      onReloadActive();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="bg-neutral-0 rounded-[10px] w-full max-w-[560px] max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between py-[0.8rem] px-4 border-b border-rim">
          <h3 className="m-0 text-[0.95rem]">Username: {u.restaurant_name || 'Restaurant'}</h3>
          <button type="button" className="btn-g btn-sm" onClick={onClose}>✕</button>
        </div>
        <div className="p-4">
          <div className="mb-4">
            {isActive ? (
              <div className="bg-wa-light border border-[#86efac] rounded-lg p-[0.7rem] text-[0.85rem]">
                Active: <strong>@{u.business_username}</strong> — <a href={`https://wa.me/${u.business_username}`} target="_blank" rel="noreferrer" className="text-acc">wa.me/{u.business_username}</a>
              </div>
            ) : isPending ? (
              <div className="bg-[#fef9c3] border border-[#fcd34d] rounded-lg p-[0.7rem] text-[0.85rem]">
                Pending claim: <strong>@{u.business_username}</strong>
              </div>
            ) : (
              <div className="bg-ink border border-rim rounded-lg p-[0.7rem] text-[0.85rem] text-dim">
                No username claimed
              </div>
            )}
          </div>

          <div className="mb-4">
            <label className={LBL_CLS}>Suggested Usernames</label>
            <div className="flex flex-wrap gap-[0.4rem]">
              {suggestions.length === 0 ? (
                <span className="text-[0.8rem] text-dim">No suggestions yet — click &quot;Regenerate&quot;</span>
              ) : suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="btn-g btn-sm text-[0.78rem]"
                  onClick={() => pickSuggestion(s)}
                >@{s}</button>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <label className={LBL_CLS}>Custom Username</label>
            <div className="flex gap-[0.4rem] items-center">
              <span className="text-[0.9rem] text-dim">@</span>
              <input
                value={custom}
                onChange={onCustomChange}
                maxLength={30}
                placeholder="beyondsnacks"
                className={`${INPUT_CLS} flex-1`}
              />
              <span className="text-[0.85rem]">{checkState.status}</span>
            </div>
            <div className="text-[0.72rem] text-red-600 min-h-[1em] mt-[0.2rem]">{checkState.error}</div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button type="button" className="btn-p btn-sm" disabled={!canSet || busy === 'set'} onClick={setTarget}>
              {busy === 'set' ? '…' : 'Set as Target Username'}
            </button>
            {isPending && (
              confirmConfirm ? (
                <>
                  <button type="button" className="btn-p btn-sm" onClick={doConfirm} disabled={busy === 'confirm'}>Confirm</button>
                  <button type="button" className="btn-g btn-sm" onClick={() => setConfirmConfirm(false)}>Cancel</button>
                </>
              ) : (
                <button type="button" className="btn-g btn-sm" onClick={() => setConfirmConfirm(true)}>Confirm Active</button>
              )
            )}
            <button type="button" className="btn-g btn-sm" onClick={doSync} disabled={busy === 'sync'}>Sync from Meta</button>
            {(isActive || isPending) && (
              confirmRelease ? (
                <>
                  <button type="button" className="btn-g btn-sm bg-red-500 text-neutral-0" onClick={doRelease} disabled={busy === 'release'}>Confirm Release</button>
                  <button type="button" className="btn-g btn-sm" onClick={() => setConfirmRelease(false)}>Cancel</button>
                </>
              ) : (
                <button type="button" className="btn-g btn-sm bg-red-500 text-neutral-0" onClick={() => setConfirmRelease(true)}>Release</button>
              )
            )}
            <button type="button" className="btn-g btn-sm" onClick={doRegenerate} disabled={busy === 'suggest'}>Regenerate Suggestions</button>
          </div>

          {isPending && (
            <div className="mt-4 bg-ink border border-rim rounded-lg p-[0.85rem] text-[0.8rem] leading-normal">
              <strong>How to claim in Meta Business Suite:</strong><br />
              1. Open Meta Business Suite for this WABA<br />
              2. Go to WhatsApp Manager → Settings → Username<br />
              3. Claim the username: <strong>@{u.business_username}</strong><br />
              4. Come back here and click &quot;Sync from Meta&quot; or &quot;Confirm Active&quot;
            </div>
          )}

          {showManual && (
            <div className="mt-3">
              <label className={LBL_CLS}>Manual entry (if Meta sync unavailable):</label>
              <div className="flex gap-[0.4rem]">
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="username claimed in Meta"
                  className={`${INPUT_CLS} flex-1`}
                />
                <button type="button" className="btn-p btn-sm" onClick={doManualConfirm} disabled={busy === 'manual'}>Confirm</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
