import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import StaffAccess from '../../components/admin/StaffAccess.jsx';
import {
  getAdminRestaurants,
  updateAdminRestaurant,
  setRestaurantCampaignCap,
  deleteAdminRestaurant,
} from '../../api/admin.js';

// Mirrors admin.html loadRestaurants (2731-2804): directory table with
// branches, catalog count, orders breakdown, fulfillment %, issues,
// revenue, status, and action buttons. Inline replacements for legacy
// window.confirm/prompt:
//   • Suspend/Activate → two-click confirm row
//   • Cap → inline numeric input row (empty clears override)
//   • Delete → name-match input (legacy parity), then Confirm
function fmtInr(n) {
  const v = Number(n || 0);
  try {
    return v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  } catch {
    return String(v);
  }
}

const STATUS_BADGE = {
  active: { color: 'var(--gb-wa-500)', label: 'Active' },
  suspended: { color: 'var(--gb-red-500)', label: 'Suspended' },
  onboarding: { color: '#3b82f6', label: 'Onboarding' },
  pending: { color: 'var(--gb-amber-500)', label: 'Pending' },
};

export default function AdminRestaurants() {
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [rowBusy, setRowBusy] = useState(null);
  // Inline action state: { id, kind: 'status'|'cap'|'delete', ...extras }
  const [pending, setPending] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getAdminRestaurants();
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to load', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((r) =>
      (r.business_name || '').toLowerCase().includes(q) ||
      (r.owner_name || '').toLowerCase().includes(q) ||
      (r.id || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const doStatus = async (r, status) => {
    setRowBusy(r.id);
    try {
      await updateAdminRestaurant(r.id, { status });
      showToast(`${r.business_name} is now ${status}`, 'success');
      setPending(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Update failed', 'error');
    } finally { setRowBusy(null); }
  };

  const doCap = async (r, capInput) => {
    let payload;
    if (capInput.trim() === '') payload = null;
    else {
      const n = Number(capInput);
      if (!Number.isFinite(n) || n < 0) return showToast('Invalid number', 'error');
      payload = n;
    }
    setRowBusy(r.id);
    try {
      await setRestaurantCampaignCap(r.id, payload);
      showToast(`Cap updated for "${r.business_name}"`, 'success');
      setPending(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Cap update failed', 'error');
    } finally { setRowBusy(null); }
  };

  const doDelete = async (r, typedName) => {
    if (typedName.trim().toLowerCase() !== (r.business_name || '').trim().toLowerCase()) {
      return showToast('Name did not match — deletion cancelled', 'error');
    }
    setRowBusy(r.id);
    try {
      await deleteAdminRestaurant(r.id);
      showToast(`"${r.business_name}" deleted and archived`, 'success');
      setPending(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Delete failed', 'error');
    } finally { setRowBusy(null); }
  };

  return (
    <div>
      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '.4rem' }}>
          <h3>🏪 Restaurant Directory</h3>
          <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, owner, ID…"
              style={{ padding: '.3rem .55rem', border: '1px solid var(--rim)', borderRadius: 6, fontSize: '.8rem', width: 240 }}
            />
            <button type="button" className="btn-sm" onClick={load} disabled={loading}>
              {loading ? '…' : '↻ Refresh'}
            </button>
          </div>
        </div>
        <div className="cb">
          {loading ? (
            <p style={{ color: 'var(--dim)' }}>Loading…</p>
          ) : !filtered.length ? (
            <p style={{ color: 'var(--dim)' }}>
              {rows.length ? 'No restaurants match your search.' : 'No restaurants yet.'}
            </p>
          ) : (
            <div className="tbl-card" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', fontSize: '.72rem', color: 'var(--dim)', textTransform: 'uppercase' }}>
                    <th style={{ padding: '.5rem' }}>Business</th>
                    <th style={{ padding: '.5rem' }}>Owner</th>
                    <th style={{ padding: '.5rem', textAlign: 'center' }}>Branches</th>
                    <th style={{ padding: '.5rem', textAlign: 'center' }}>Catalogs</th>
                    <th style={{ padding: '.5rem', textAlign: 'center' }}>Orders</th>
                    <th style={{ padding: '.5rem', textAlign: 'center' }}>Fulfil%</th>
                    <th style={{ padding: '.5rem', textAlign: 'center' }}>Issues</th>
                    <th style={{ padding: '.5rem' }}>Revenue</th>
                    <th style={{ padding: '.5rem' }}>Status</th>
                    <th style={{ padding: '.5rem', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <RestaurantRow
                      key={r.id}
                      r={r}
                      busy={rowBusy === r.id}
                      pending={pending && pending.id === r.id ? pending : null}
                      onAsk={(kind, extra = {}) => setPending({ id: r.id, kind, ...extra })}
                      onCancel={() => setPending(null)}
                      onStatus={doStatus}
                      onCap={doCap}
                      onDelete={doDelete}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RestaurantRow({ r, busy, pending, onAsk, onCancel, onStatus, onCap, onDelete }) {
  const o = r.orders || {};
  const fpct = r.fulfillment_pct || 0;
  const fColor = fpct >= 80 ? 'var(--gb-wa-500)' : fpct >= 50 ? 'var(--gb-amber-500)' : 'var(--gb-red-500)';
  const badge = STATUS_BADGE[r.status] || { color: 'var(--gb-neutral-500)', label: r.status };
  const orderTip = [
    `Delivered: ${o.delivered || 0}`,
    `Pending: ${o.pending || 0}`,
    `Confirmed: ${o.confirmed || 0}`,
    `Preparing: ${o.preparing || 0}`,
    `Out for Delivery: ${o.out_for_delivery || 0}`,
    `Cancelled: ${o.cancelled || 0}`,
  ].join('\n');

  const staffPinOpen = pending?.kind === 'staffPin';

  return (
    <>
    <tr style={{ borderBottom: staffPinOpen ? 'none' : '1px solid var(--rim)' }}>
      <td data-label="Business" style={{ padding: '.5rem' }}>
        <div style={{ fontWeight: 600, fontSize: '.84rem' }}>{r.business_name}</div>
        <div style={{ color: 'var(--dim)', fontSize: '.7rem', fontFamily: 'monospace' }}>{(r.id || '').slice(0, 8)}</div>
      </td>
      <td data-label="Owner" style={{ padding: '.5rem', fontSize: '.8rem' }}>{r.owner_name || '—'}</td>
      <td data-label="Branches" style={{ padding: '.5rem', textAlign: 'center', fontSize: '.82rem' }}>{r.branch_count ?? 0}</td>
      <td data-label="Catalogs" style={{ padding: '.5rem', textAlign: 'center', fontSize: '.82rem' }}>{r.catalog_count ?? 0}</td>
      <td data-label="Orders" style={{ padding: '.5rem', textAlign: 'center', cursor: 'help' }} title={orderTip}>
        <div style={{ fontWeight: 600, fontSize: '.84rem' }}>{o.total ?? 0}</div>
        <div style={{ color: 'var(--gb-wa-500)', fontSize: '.7rem' }}>{o.delivered ?? 0} del</div>
      </td>
      <td data-label="Fulfil%" style={{ padding: '.5rem', textAlign: 'center' }}>
        <span style={{ color: fColor, fontWeight: 600 }}>{fpct}%</span>
      </td>
      <td data-label="Issues" style={{ padding: '.5rem', textAlign: 'center' }}>
        {r.issues
          ? <span style={{ color: 'var(--gb-red-500)', fontWeight: 600 }}>{r.issues}</span>
          : <span style={{ color: 'var(--mute,#94a3b8)' }}>0</span>}
      </td>
      <td data-label="Revenue" style={{ padding: '.5rem', fontSize: '.82rem' }}>₹{fmtInr(r.revenue_rs)}</td>
      <td data-label="Status" style={{ padding: '.5rem' }}>
        <span style={{ display: 'inline-block', padding: '.1rem .4rem', borderRadius: 99, background: `${badge.color}15`, color: badge.color, border: `1px solid ${badge.color}30`, fontSize: '.7rem', fontWeight: 600 }}>
          {badge.label}
        </span>
      </td>
      <td data-label="Actions" style={{ padding: '.5rem', textAlign: 'right', whiteSpace: 'normal' }}>
        {pending?.kind === 'status' ? (
          <InlineConfirm
            label={`${pending.target === 'suspended' ? 'Suspend' : 'Activate'} "${r.business_name}"?`}
            busy={busy}
            onConfirm={() => onStatus(r, pending.target)}
            onCancel={onCancel}
            confirmColor={pending.target === 'suspended' ? 'var(--gb-red-500)' : 'var(--gb-wa-500)'}
          />
        ) : pending?.kind === 'cap' ? (
          <CapEditor
            current={r.campaign_daily_cap}
            busy={busy}
            onConfirm={(val) => onCap(r, val)}
            onCancel={onCancel}
          />
        ) : pending?.kind === 'delete' ? (
          <DeleteEditor
            name={r.business_name}
            busy={busy}
            onConfirm={(typed) => onDelete(r, typed)}
            onCancel={onCancel}
          />
        ) : (
          <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '.25rem', justifyContent: 'flex-end' }}>
            {r.status === 'active' ? (
              <button type="button" className="btn-sm" style={{ fontSize: '.72rem', color: 'var(--gb-red-500)' }} onClick={() => onAsk('status', { target: 'suspended' })} disabled={busy}>
                Suspend
              </button>
            ) : (
              <button type="button" className="btn-p btn-sm" style={{ fontSize: '.72rem' }} onClick={() => onAsk('status', { target: 'active' })} disabled={busy}>
                Activate
              </button>
            )}
            <button type="button" className="btn-sm" style={{ fontSize: '.72rem' }} onClick={() => onAsk('cap')} disabled={busy}>
              Cap
            </button>
            <button
              type="button"
              className="btn-sm"
              style={{ fontSize: '.72rem' }}
              onClick={() => (staffPinOpen ? onCancel() : onAsk('staffPin'))}
              disabled={busy}
              aria-expanded={staffPinOpen}
            >
              {staffPinOpen ? 'Close Staff PIN' : 'Staff PIN'}
            </button>
            <button type="button" className="btn-sm" style={{ fontSize: '.72rem', color: 'var(--gb-red-500)' }} onClick={() => onAsk('delete')} disabled={busy}>
              Delete
            </button>
          </div>
        )}
      </td>
    </tr>
    {staffPinOpen && (
      <tr style={{ borderBottom: '1px solid var(--rim)', background: 'var(--bg-soft, #f8fafc)' }}>
        <td colSpan={10} style={{ padding: '.5rem .75rem 1rem' }}>
          <StaffAccess restaurantId={r.id} slug={r.slug} />
        </td>
      </tr>
    )}
    </>
  );
}

function InlineConfirm({ label, busy, onConfirm, onCancel, confirmColor = 'var(--gb-red-500)' }) {
  return (
    <span style={{ display: 'inline-flex', gap: '.25rem', alignItems: 'center' }}>
      <span style={{ fontSize: '.72rem', color: 'var(--dim)', marginRight: '.2rem' }}>{label}</span>
      <button type="button" style={{ background: confirmColor, color: 'var(--gb-neutral-0)', border: 'none', borderRadius: 4, padding: '.15rem .5rem', fontSize: '.72rem' }} onClick={onConfirm} disabled={busy}>
        {busy ? '…' : 'Confirm'}
      </button>
      <button type="button" className="btn-g btn-sm" style={{ fontSize: '.72rem' }} onClick={onCancel} disabled={busy}>Cancel</button>
    </span>
  );
}

function CapEditor({ current, busy, onConfirm, onCancel }) {
  const [val, setVal] = useState(current == null ? '' : String(current));
  return (
    <span style={{ display: 'inline-flex', gap: '.25rem', alignItems: 'center' }}>
      <span style={{ fontSize: '.7rem', color: 'var(--dim)' }}>
        Current: {current == null ? '(default)' : current} — new:
      </span>
      <input
        type="number"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="blank = default"
        autoFocus
        style={{ width: 110, padding: '.15rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }}
      />
      <button type="button" className="btn-p btn-sm" style={{ fontSize: '.72rem' }} onClick={() => onConfirm(val)} disabled={busy}>
        {busy ? '…' : 'Save'}
      </button>
      <button type="button" className="btn-g btn-sm" style={{ fontSize: '.72rem' }} onClick={onCancel} disabled={busy}>Cancel</button>
    </span>
  );
}

function DeleteEditor({ name, busy, onConfirm, onCancel }) {
  const [typed, setTyped] = useState('');
  const match = typed.trim().toLowerCase() === (name || '').trim().toLowerCase();
  return (
    <span style={{ display: 'inline-flex', gap: '.25rem', alignItems: 'center' }}>
      <span style={{ fontSize: '.7rem', color: 'var(--gb-red-500)' }}>
        Type "{name}" to confirm:
      </span>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={name}
        autoFocus
        style={{ width: 140, padding: '.15rem .3rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.72rem' }}
      />
      <button type="button" style={{ background: 'var(--gb-red-500)', color: 'var(--gb-neutral-0)', border: 'none', borderRadius: 4, padding: '.15rem .5rem', fontSize: '.72rem', opacity: match ? 1 : 0.5 }} onClick={() => onConfirm(typed)} disabled={busy || !match}>
        {busy ? '…' : 'Delete'}
      </button>
      <button type="button" className="btn-g btn-sm" style={{ fontSize: '.72rem' }} onClick={onCancel} disabled={busy}>Cancel</button>
    </span>
  );
}
