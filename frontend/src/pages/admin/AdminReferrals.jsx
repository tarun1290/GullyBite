import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import StatCard from '../../components/StatCard.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import {
  createReferral,
  getAdminRestaurants,
  getReferralStats,
  getReferrals,
} from '../../api/admin.js';

// Mirrors admin.html loadReferrals + createReferral (3203-3321).
// Stats strip, inline create form (reveals shareable WA link), 9-col table.

const STATUS_COLOR = { active: '#22c55e', converted: '#7c3aed', expired: '#6b7280' };

function fmtInr(n) {
  const v = Number(n || 0);
  try {
    return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch { return String(v); }
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
  } catch { return '—'; }
}

function timeUntil(ts) {
  const diff = new Date(ts) - Date.now();
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

export default function AdminReferrals() {
  const { showToast } = useToast();
  const [stats, setStats] = useState(null);
  const [statsErr, setStatsErr] = useState(null);
  const [restaurants, setRestaurants] = useState([]);
  const [restaurantId, setRestaurantId] = useState('');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [linkBox, setLinkBox] = useState(null);
  const [creating, setCreating] = useState(false);

  const [rows, setRows] = useState([]);
  const [listErr, setListErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async () => {
    try {
      const s = await getReferralStats();
      setStats(s);
      setStatsErr(null);
    } catch (e) {
      setStatsErr(e?.response?.data?.error || e?.message || 'Stats failed');
    }
  }, []);

  const loadRestaurants = useCallback(async () => {
    try {
      const list = await getAdminRestaurants();
      const items = Array.isArray(list) ? list : (list?.restaurants || []);
      setRestaurants(items);
    } catch {
      setRestaurants([]);
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const r = await getReferrals();
      setRows(Array.isArray(r) ? r : []);
      setListErr(null);
    } catch (e) {
      setListErr(e?.response?.data?.error || e?.message || 'Failed to load referrals');
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadStats(), loadList(), loadRestaurants()]);
    setLoading(false);
  }, [loadStats, loadList, loadRestaurants]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const doCreate = async () => {
    if (!restaurantId) return showToast('Select a restaurant', 'error');
    if (!phone.trim()) return showToast('Enter customer WhatsApp number', 'error');
    setCreating(true);
    try {
      const ref = await createReferral({
        restaurantId,
        customerWaPhone: phone.trim(),
        customerName: name.trim(),
        notes: notes.trim(),
      });
      const restaurant = restaurants.find((r) => (r.id || r.restaurant_id) === restaurantId);
      const waUsername = ref?.restaurant_wa_username || '';
      const waPhone = ref?.restaurant_wa_phone || '';
      const link = waUsername
        ? `https://wa.me/${waUsername}?text=Hi! I want to order food.`
        : waPhone
          ? `https://wa.me/${String(waPhone).replace(/[^0-9]/g, '')}?text=Hi! I want to order food.`
          : `(No WhatsApp number connected for ${restaurant?.business_name || 'restaurant'})`;
      setLinkBox(link);
      setPhone('');
      setName('');
      setNotes('');
      showToast('Referral created — attribution active for 8 hours', 'success');
      await loadStats();
      await loadList();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Create failed', 'error');
    } finally {
      setCreating(false);
    }
  };

  const copyLink = async () => {
    if (!linkBox) return;
    try {
      await navigator.clipboard.writeText(linkBox);
      showToast('Link copied', 'success');
    } catch {
      showToast('Copy failed — please copy manually', 'error');
    }
  };

  return (
    <div id="pg-referrals">
      {statsErr ? (
        <div style={{ marginBottom: '1rem' }}>
          <SectionError message={statsErr} onRetry={loadStats} />
        </div>
      ) : (
        <div className="stats">
          <StatCard label="Total Referrals"     value={loading ? '—' : (stats?.total ?? 0)} delta="All time" />
          <StatCard label="Active (within 8h)"  value={loading ? '—' : (stats?.active ?? 0)} delta="Attribution live" />
          <StatCard label="Converted"           value={loading ? '—' : (stats?.converted ?? 0)} delta="Placed an order" />
          <StatCard
            label="Total Referral Fees"
            value={loading ? '—' : `₹${fmtInr(stats?.total_referral_fee_rs)}`}
            delta="7.5% of order value"
          />
        </div>
      )}

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch"><h3>Send a Referral</h3></div>
        <div className="cb" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '.8rem', alignItems: 'end' }}>
          <div>
            <label style={lbl}>Restaurant</label>
            <select
              value={restaurantId}
              onChange={(e) => setRestaurantId(e.target.value)}
              style={{ ...input, width: '100%' }}
            >
              <option value="">Select restaurant…</option>
              {restaurants.map((r) => {
                const id = r.id || r.restaurant_id;
                return <option key={id} value={id}>{r.business_name || r.name || id}</option>;
              })}
            </select>
          </div>
          <div>
            <label style={lbl}>Customer WhatsApp Number</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="919876543210"
              style={{ ...input, width: '100%' }}
            />
          </div>
          <div>
            <label style={lbl}>Customer Name (optional)</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Rahul Sharma"
              style={{ ...input, width: '100%' }}
            />
          </div>
          <button
            type="button"
            className="btn-p btn-sm"
            onClick={doCreate}
            disabled={creating}
            style={{ background: '#7c3aed', color: '#fff', whiteSpace: 'nowrap' }}
          >
            {creating ? 'Creating…' : '+ Create Referral'}
          </button>
        </div>
        <div className="cb" style={{ paddingTop: 0 }}>
          <label style={lbl}>Notes (optional)</label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Customer asked about biryanis on Instagram"
            style={{ ...input, width: '100%' }}
          />
          {linkBox && (
            <div style={{
              marginTop: '.9rem', background: 'var(--ink3)',
              border: '1px solid rgba(124,58,237,.26)', borderRadius: 8, padding: '.8rem 1rem',
            }}>
              <div style={{ fontSize: '.76rem', color: '#7c3aed', marginBottom: '.4rem' }}>
                Referral created — share this restaurant's WhatsApp link with the customer. Attribution is live for 8 hours.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
                <code className="mono" style={{ flex: 1, fontSize: '.8rem', wordBreak: 'break-all' }}>{linkBox}</code>
                <button type="button" className="btn-g btn-sm" onClick={copyLink}>Copy Link</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>All Referrals</h3>
          <button type="button" className="btn-g btn-sm" onClick={loadList} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadList} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', borderBottom: '1px solid var(--rim)' }}>
                  <th style={th}>Customer Phone</th>
                  <th style={th}>Customer Name</th>
                  <th style={th}>Restaurant</th>
                  <th style={th}>Status</th>
                  <th style={th}>Expires / Expired</th>
                  <th style={th}>Orders</th>
                  <th style={th}>Order Value</th>
                  <th style={th}>Referral Fee (7.5%)</th>
                  <th style={th}>Created</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={9} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={9} style={emptyCell}>No referrals yet</td></tr>
                ) : (
                  rows.map((r) => {
                    const color = STATUS_COLOR[r.status] || '#6b7280';
                    return (
                      <tr key={r._id || r.id || `${r.customer_wa_phone}-${r.created_at}`} style={{ borderBottom: '1px solid var(--rim)' }}>
                        <td style={td} className="mono">{r.customer_wa_phone}</td>
                        <td style={td}>{r.customer_name || '—'}</td>
                        <td style={td}>{r.restaurant_name}</td>
                        <td style={td}>
                          <span style={{ color, fontWeight: 600, textTransform: 'capitalize' }}>{r.status}</span>
                        </td>
                        <td style={{ ...td, fontSize: '.78rem' }}>
                          {r.status === 'active' ? (
                            <span style={{ color: '#22c55e' }}>Expires {timeUntil(r.expires_at)}</span>
                          ) : (
                            fmtDate(r.expires_at)
                          )}
                        </td>
                        <td style={td}>{r.orders_count}</td>
                        <td style={td}>₹{fmtInr(r.total_order_value_rs)}</td>
                        <td style={{ ...td, fontWeight: 600, color: '#a78bfa' }}>
                          ₹{fmtInr(r.referral_fee_rs)}
                        </td>
                        <td style={{ ...td, fontSize: '.78rem' }}>{fmtDate(r.created_at)}</td>
                      </tr>
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

const th = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td = { padding: '.6rem .7rem', verticalAlign: 'top' };
const emptyCell = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const lbl = { fontSize: '.72rem', color: 'var(--dim)', display: 'block', marginBottom: '.25rem' };
const input = { background: '#fff', border: '1px solid var(--rim)', borderRadius: 6, padding: '.4rem .6rem', fontSize: '.82rem' };
