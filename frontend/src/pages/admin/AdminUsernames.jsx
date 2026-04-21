import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
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
} from '../../api/admin.js';

// Mirrors admin.html username management (3533-3729): list with status/search
// filters, bulk "Auto-Suggest All" + "Sync All", per-row Manage modal with
// suggestion chips, debounced custom-username availability check, set target /
// confirm / sync / release / regenerate / manual confirm actions.

const STATUS_COLORS = {
  active:        { bg: 'rgba(34,197,94,.12)',  fg: '#047857' },
  pending_claim: { bg: 'rgba(234,179,8,.15)',  fg: '#a16207' },
  suggested:     { bg: 'rgba(59,130,246,.12)', fg: 'var(--gb-blue-600)' },
  not_claimed:   { bg: 'rgba(148,163,184,.18)', fg: 'var(--gb-slate-700)' },
  released:      { bg: 'rgba(239,68,68,.15)',  fg: 'var(--gb-red-600)' },
  rejected:      { bg: 'rgba(239,68,68,.15)',  fg: 'var(--gb-red-600)' },
};

function statusBadge(s) {
  const cfg = STATUS_COLORS[s] || STATUS_COLORS.not_claimed;
  return (
    <span style={{
      display: 'inline-block', padding: '.1rem .5rem', borderRadius: 10,
      fontSize: '.72rem', fontWeight: 600, background: cfg.bg, color: cfg.fg,
    }}>{(s || 'not_claimed').replace(/_/g, ' ')}</span>
  );
}

export default function AdminUsernames() {
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const [status, setStatus] = useState('all');
  const [pendingSearch, setPendingSearch] = useState('');
  const [search, setSearch] = useState('');

  const [busyBulk, setBusyBulk] = useState(false);
  const [active, setActive] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(pendingSearch), 350);
    return () => clearTimeout(t);
  }, [pendingSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = {};
    if (search) params.search = search;
    if (status && status !== 'all') params.status = status;
    try {
      const d = await getUsernames(params);
      setRows(Array.isArray(d) ? d : (d?.items || []));
      setErr(null);
    } catch (e) {
      setRows([]);
      setErr(e?.response?.data?.error || e?.message || 'Failed to load usernames');
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => { load(); }, [load]);

  const doAutoSuggestAll = async () => {
    setBusyBulk(true);
    try {
      const r = await autoSuggestUsernamesAll();
      showToast(`Suggestions generated for ${r?.updated ?? 0} / ${r?.total ?? 0} accounts`, 'ok');
      load();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Auto-suggest failed', 'err');
    } finally {
      setBusyBulk(false);
    }
  };

  const doSyncAll = async () => {
    setBusyBulk(true);
    try {
      const r = await syncUsernamesAll();
      showToast(`Sync: ${r?.synced ?? 0} synced, ${r?.not_available ?? 0} unavailable, ${r?.failed ?? 0} failed`, 'ok');
      load();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Sync failed', 'err');
    } finally {
      setBusyBulk(false);
    }
  };

  return (
    <div id="pg-usernames">
      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '.5rem' }}>
          <h3 style={{ margin: 0 }}>Business Usernames</h3>
          <div style={{ display: 'flex', gap: '.4rem' }}>
            <button type="button" className="btn-p btn-sm" onClick={doAutoSuggestAll} disabled={busyBulk}>Auto-Suggest All</button>
            <button type="button" className="btn-g btn-sm" onClick={doSyncAll} disabled={busyBulk}>Sync All from Meta</button>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', padding: '.75rem 1rem', borderBottom: '1px solid var(--rim)' }}>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={input}>
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
            style={{ ...input, flex: 1, maxWidth: 280 }}
          />
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', textAlign: 'left', color: 'var(--dim)', fontSize: '.74rem' }}>
                  <th style={th}>Restaurant</th>
                  <th style={th}>WABA Display</th>
                  <th style={th}>Username</th>
                  <th style={th}>Status</th>
                  <th style={th}>wa.me Link</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} style={emptyCell}>No usernames found.</td></tr>
                ) : rows.map((u) => {
                  const waLink = (u.business_username && u.username_status === 'active')
                    ? `wa.me/${u.business_username}`
                    : u.wa_phone_number ? `wa.me/${u.wa_phone_number}` : '';
                  return (
                    <tr key={u._id} style={{ borderTop: '1px solid var(--rim)' }}>
                      <td style={td}>
                        {u.restaurant_name || '—'}
                        {u.city && <><br /><span style={{ fontSize: '.72rem', color: 'var(--dim)' }}>{u.city}</span></>}
                      </td>
                      <td style={td}>{u.display_name || '—'}</td>
                      <td style={td} className="mono">{u.business_username ? '@' + u.business_username : <span style={{ color: 'var(--dim)' }}>—</span>}</td>
                      <td style={td}>{statusBadge(u.username_status)}</td>
                      <td style={{ ...td, fontSize: '.78rem' }}>
                        {waLink ? <a href={`https://${waLink}`} target="_blank" rel="noreferrer" style={{ color: 'var(--acc, #4f46e5)' }}>{waLink}</a> : '—'}
                      </td>
                      <td style={td}><button type="button" className="btn-g btn-sm" onClick={() => setActive(u)}>Manage</button></td>
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
              const d = await getUsernames({});
              const items = Array.isArray(d) ? d : (d?.items || []);
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

function UsernameModal({ account: u, onClose, onReloadList, onReloadActive }) {
  const { showToast } = useToast();
  const [custom, setCustom] = useState('');
  const [checkState, setCheckState] = useState({ status: '', error: '' });
  const [canSet, setCanSet] = useState(false);
  const [busy, setBusy] = useState(null);
  const [showManual, setShowManual] = useState(false);
  const [manual, setManual] = useState('');
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [confirmConfirm, setConfirmConfirm] = useState(false);
  const debounceRef = useRef(null);

  const waid = u._id;
  const isActive = u.username_status === 'active';
  const isPending = u.username_status === 'pending_claim';
  const suggestions = u.username_suggestions || [];

  const validate = (val) => {
    setCheckState({ status: '', error: '' });
    setCanSet(false);
    const v = val.trim().toLowerCase();
    if (!v) return;
    if (v.length < 5) {
      setCheckState({ status: '❌', error: 'Min 5 characters' });
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await checkUsername(waid, v);
        if (r?.available) {
          setCheckState({ status: '✅', error: '' });
          setCanSet(true);
        } else {
          setCheckState({ status: '❌', error: r?.error || 'Not available' });
          setCanSet(false);
        }
      } catch (e) {
        setCheckState({ status: '❌', error: e?.response?.data?.error || e?.message || 'Check failed' });
        setCanSet(false);
      }
    }, 400);
  };

  const onCustomChange = (e) => {
    const v = e.target.value;
    setCustom(v);
    validate(v);
  };

  const pickSuggestion = (s) => {
    setCustom(s);
    validate(s);
  };

  const setTarget = async () => {
    const v = custom.trim().toLowerCase();
    if (!v) return;
    setBusy('set');
    try {
      await setUsernameTarget(waid, v);
      showToast(`Target username set: @${v}`, 'ok');
      onClose();
      onReloadList();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Failed', 'err');
    } finally {
      setBusy(null);
    }
  };

  const doConfirm = async () => {
    if (!u.business_username) return;
    setBusy('confirm');
    try {
      await confirmUsername(waid, u.business_username);
      showToast(`@${u.business_username} is now active!`, 'ok');
      onClose();
      onReloadList();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Failed', 'err');
    } finally {
      setBusy(null);
    }
  };

  const doSync = async () => {
    setBusy('sync');
    try {
      const r = await syncUsername(waid);
      if (r?.synced) {
        showToast(`Synced: @${r.username}`, 'ok');
        onClose();
        onReloadList();
      } else {
        showToast(r?.reason || 'No username found on Meta', 'info');
        setShowManual(true);
      }
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Sync failed', 'err');
    } finally {
      setBusy(null);
    }
  };

  const doManualConfirm = async () => {
    const v = manual.trim().toLowerCase();
    if (!v) return showToast('Enter a username', 'err');
    setBusy('manual');
    try {
      await confirmUsername(waid, v);
      showToast(`Username @${v} confirmed!`, 'ok');
      onClose();
      onReloadList();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Failed', 'err');
    } finally {
      setBusy(null);
    }
  };

  const doRelease = async () => {
    setBusy('release');
    try {
      await releaseUsername(waid);
      showToast('Username released', 'ok');
      onClose();
      onReloadList();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Release failed', 'err');
    } finally {
      setBusy(null);
    }
  };

  const doRegenerate = async () => {
    setBusy('suggest');
    try {
      const r = await suggestUsernames(waid);
      showToast(`Generated ${r?.suggestions?.length || 0} suggestions`, 'ok');
      onReloadActive();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Failed', 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem' }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--gb-neutral-0)', borderRadius: 10, width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '.8rem 1rem', borderBottom: '1px solid var(--rim)' }}>
          <h3 style={{ margin: 0, fontSize: '.95rem' }}>Username: {u.restaurant_name || 'Restaurant'}</h3>
          <button type="button" className="btn-g btn-sm" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '1rem' }}>
          <div style={{ marginBottom: '1rem' }}>
            {isActive ? (
              <div style={{ background: 'var(--gb-wa-light)', border: '1px solid #86efac', borderRadius: 8, padding: '.7rem', fontSize: '.85rem' }}>
                Active: <strong>@{u.business_username}</strong> — <a href={`https://wa.me/${u.business_username}`} target="_blank" rel="noreferrer" style={{ color: 'var(--acc, #4f46e5)' }}>wa.me/{u.business_username}</a>
              </div>
            ) : isPending ? (
              <div style={{ background: '#fef9c3', border: '1px solid #fcd34d', borderRadius: 8, padding: '.7rem', fontSize: '.85rem' }}>
                Pending claim: <strong>@{u.business_username}</strong>
              </div>
            ) : (
              <div style={{ background: 'var(--ink)', border: '1px solid var(--rim)', borderRadius: 8, padding: '.7rem', fontSize: '.85rem', color: 'var(--dim)' }}>
                No username claimed
              </div>
            )}
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={lbl}>Suggested Usernames</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem' }}>
              {suggestions.length === 0 ? (
                <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>No suggestions yet — click "Regenerate"</span>
              ) : suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="btn-g btn-sm"
                  style={{ fontSize: '.78rem' }}
                  onClick={() => pickSuggestion(s)}
                >@{s}</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={lbl}>Custom Username</label>
            <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
              <span style={{ fontSize: '.9rem', color: 'var(--dim)' }}>@</span>
              <input
                value={custom}
                onChange={onCustomChange}
                maxLength={30}
                placeholder="beyondsnacks"
                style={{ ...input, flex: 1 }}
              />
              <span style={{ fontSize: '.85rem' }}>{checkState.status}</span>
            </div>
            <div style={{ fontSize: '.72rem', color: 'var(--gb-red-600)', minHeight: '1em', marginTop: '.2rem' }}>{checkState.error}</div>
          </div>

          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
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
                  <button type="button" className="btn-g btn-sm" style={{ background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)' }} onClick={doRelease} disabled={busy === 'release'}>Confirm Release</button>
                  <button type="button" className="btn-g btn-sm" onClick={() => setConfirmRelease(false)}>Cancel</button>
                </>
              ) : (
                <button type="button" className="btn-g btn-sm" style={{ background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)' }} onClick={() => setConfirmRelease(true)}>Release</button>
              )
            )}
            <button type="button" className="btn-g btn-sm" onClick={doRegenerate} disabled={busy === 'suggest'}>Regenerate Suggestions</button>
          </div>

          {isPending && (
            <div style={{ marginTop: '1rem', background: 'var(--ink)', border: '1px solid var(--rim)', borderRadius: 8, padding: '.85rem', fontSize: '.8rem', lineHeight: 1.5 }}>
              <strong>How to claim in Meta Business Suite:</strong><br />
              1. Open Meta Business Suite for this WABA<br />
              2. Go to WhatsApp Manager → Settings → Username<br />
              3. Claim the username: <strong>@{u.business_username}</strong><br />
              4. Come back here and click "Sync from Meta" or "Confirm Active"
            </div>
          )}

          {showManual && (
            <div style={{ marginTop: '.75rem' }}>
              <label style={lbl}>Manual entry (if Meta sync unavailable):</label>
              <div style={{ display: 'flex', gap: '.4rem' }}>
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="username claimed in Meta"
                  style={{ ...input, flex: 1 }}
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

const th = { padding: '.5rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td = { padding: '.5rem .7rem', verticalAlign: 'top' };
const emptyCell = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.45rem .7rem', fontSize: '.85rem' };
const lbl = { fontSize: '.78rem', color: 'var(--dim)', display: 'block', marginBottom: '.3rem' };
