'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  createReferral,
  createReferralLink,
  getAdminRestaurants,
  getReferralLinkRequests,
  getReferralStats,
  getReferrals,
  resolveReferralLinkRequest,
} from '../../../api/admin';

const STATUS_COLOR: Record<string, string> = {
  active: '#22c55e',
  converted: 'var(--gb-violet-600)',
  expired: 'var(--gb-neutral-500)',
};

interface ReferralStats {
  total?: number;
  active?: number;
  converted?: number;
  total_referral_fee_rs?: number | string;
}

interface AdminReferral {
  _id?: string;
  id?: string;
  customer_wa_phone?: string;
  customer_name?: string;
  restaurant_name?: string;
  status?: string;
  expires_at?: string;
  orders_count?: number;
  total_order_value_rs?: number | string;
  referral_fee_rs?: number | string;
  created_at?: string;
}

interface RestaurantApiRow {
  id?: string;
  _id?: string;
  restaurant_id?: string;
  business_name?: string;
  name?: string;
}

interface RestaurantsEnvelope { restaurants?: RestaurantApiRow[] }

interface CreatedReferral {
  restaurant_wa_username?: string;
  restaurant_wa_phone?: string;
}

interface LinkRequest {
  _id?: string;
  id?: string;
  restaurant_id?: string;
  restaurant_name?: string | null;
  campaign_name?: string | null;
  status?: string;
  created_at?: string;
}

interface LinkRequestsEnvelope { requests?: LinkRequest[] }

function fmtInr(n: number | string | null | undefined): string {
  const v = Number(n || 0);
  try {
    return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch { return String(v); }
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
  } catch { return '—'; }
}

function timeUntil(ts?: string): string {
  if (!ts) return '—';
  const diff = new Date(ts).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

function timeAgo(ts?: string): string {
  if (!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const th: CSSProperties = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.6rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const lbl: CSSProperties = { fontSize: '.72rem', color: 'var(--dim)', display: 'block', marginBottom: '.25rem' };
const input: CSSProperties = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.4rem .6rem', fontSize: '.82rem' };

export default function AdminReferralsPage() {
  const { showToast } = useToast();
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [restaurants, setRestaurants] = useState<RestaurantApiRow[]>([]);
  const [restaurantId, setRestaurantId] = useState<string>('');
  const [phone, setPhone] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [linkBox, setLinkBox] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);

  const [rows, setRows] = useState<AdminReferral[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const [linkRequests, setLinkRequests] = useState<LinkRequest[]>([]);
  const [linkRequestsErr, setLinkRequestsErr] = useState<string | null>(null);
  // Per-request in-flight flag (keyed by request _id) so the right button
  // shows a spinner without disabling the others.
  const [generating, setGenerating] = useState<Record<string, boolean>>({});

  const loadStats = useCallback(async () => {
    try {
      const s = (await getReferralStats()) as ReferralStats | null;
      setStats(s);
      setStatsErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setStatsErr(er?.response?.data?.error || er?.message || 'Stats failed');
    }
  }, []);

  const loadRestaurants = useCallback(async () => {
    try {
      const list = (await getAdminRestaurants()) as RestaurantApiRow[] | RestaurantsEnvelope | null;
      const items: RestaurantApiRow[] = Array.isArray(list) ? list : (list?.restaurants || []);
      setRestaurants(items);
    } catch {
      setRestaurants([]);
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const r = (await getReferrals()) as AdminReferral[] | null;
      setRows(Array.isArray(r) ? r : []);
      setListErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setListErr(er?.response?.data?.error || er?.message || 'Failed to load referrals');
    }
  }, []);

  const loadLinkRequests = useCallback(async () => {
    try {
      const r = (await getReferralLinkRequests()) as LinkRequestsEnvelope | null;
      setLinkRequests(Array.isArray(r?.requests) ? r!.requests! : []);
      setLinkRequestsErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setLinkRequestsErr(er?.response?.data?.error || er?.message || 'Failed to load link requests');
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadStats(), loadList(), loadRestaurants(), loadLinkRequests()]);
    setLoading(false);
  }, [loadStats, loadList, loadRestaurants, loadLinkRequests]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const doCreate = async () => {
    if (!restaurantId) { showToast('Select a restaurant', 'error'); return; }
    if (!phone.trim()) { showToast('Enter customer WhatsApp number', 'error'); return; }
    setCreating(true);
    try {
      const ref = (await createReferral({
        restaurantId,
        customerWaPhone: phone.trim(),
        customerName: name.trim(),
        notes: notes.trim(),
      })) as CreatedReferral | null;
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
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Create failed', 'error');
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

  // Mint a GBREF link for a pending request, then mark the request resolved.
  // Both calls are guarded — partial success is acceptable: link minted but
  // resolution failed leaves the request visible for retry, which is fine.
  const generateForRequest = async (req: LinkRequest) => {
    if (!req._id || !req.restaurant_id) return;
    setGenerating((g) => ({ ...g, [req._id!]: true }));
    try {
      const link = (await createReferralLink(req.restaurant_id, req.campaign_name || undefined)) as { wa_link?: string; code?: string } | null;
      try {
        await resolveReferralLinkRequest(req._id);
      } catch {
        // Non-fatal — the link is created; ops can clear the row manually.
      }
      const codeLabel = link?.code ? `GBREF-${link.code}` : 'link';
      showToast(`${codeLabel} created for ${req.restaurant_name || 'restaurant'}`, 'success');
      if (link?.wa_link) setLinkBox(link.wa_link);
      await loadLinkRequests();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Generate failed', 'error');
    } finally {
      setGenerating((g) => {
        const next = { ...g };
        delete next[req._id!];
        return next;
      });
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
            style={{ background: 'var(--gb-violet-600)', color: 'var(--gb-neutral-0)', whiteSpace: 'nowrap' }}
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
              <div style={{ fontSize: '.76rem', color: 'var(--gb-violet-600)', marginBottom: '.4rem' }}>
                Referral created — share this restaurant&apos;s WhatsApp link with the customer. Attribution is live for 8 hours.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
                <code className="mono" style={{ flex: 1, fontSize: '.8rem', wordBreak: 'break-all' }}>{linkBox}</code>
                <button type="button" className="btn-g btn-sm" onClick={copyLink}>Copy Link</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Pending GBREF link requests ─────────────────────────
          Restaurants self-serve a request for a shareable GBREF link via
          the dashboard; admin generates and the request collapses. */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>Pending Link Requests</h3>
          <button type="button" className="btn-g btn-sm" onClick={loadLinkRequests} disabled={loading}>↻ Refresh</button>
        </div>
        {linkRequestsErr ? (
          <div className="cb"><SectionError message={linkRequestsErr} onRetry={loadLinkRequests} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', borderBottom: '1px solid var(--rim)' }}>
                  <th style={th}>Restaurant</th>
                  <th style={th}>Campaign</th>
                  <th style={th}>Requested</th>
                  <th style={th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && linkRequests.length === 0 ? (
                  <tr><td colSpan={4} style={emptyCell}>Loading…</td></tr>
                ) : linkRequests.length === 0 ? (
                  <tr><td colSpan={4} style={emptyCell}>No pending link requests</td></tr>
                ) : (
                  linkRequests.map((req) => (
                    <tr key={req._id || req.id} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td style={td}>{req.restaurant_name || req.restaurant_id || '—'}</td>
                      <td style={td}>{req.campaign_name || <span style={{ color: 'var(--dim)' }}>—</span>}</td>
                      <td style={{ ...td, fontSize: '.78rem', color: 'var(--dim)' }}>{timeAgo(req.created_at)}</td>
                      <td style={td}>
                        <button
                          type="button"
                          className="btn-p btn-sm"
                          onClick={() => generateForRequest(req)}
                          disabled={!!generating[req._id || '']}
                          style={{ background: 'var(--gb-violet-600)', color: 'var(--gb-neutral-0)' }}
                        >
                          {generating[req._id || ''] ? 'Generating…' : 'Generate Link'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
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
                    const color = STATUS_COLOR[r.status || ''] || 'var(--gb-neutral-500)';
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
