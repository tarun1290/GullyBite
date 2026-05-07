'use client';

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

const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.6rem] px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const LBL_CLS = 'text-[0.72rem] text-dim block mb-1';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.4rem] px-[0.6rem] text-[0.82rem]';

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
        <div className="mb-4">
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

      <div className="card mb-4">
        <div className="ch"><h3>Send a Referral</h3></div>
        <div className="cb grid grid-cols-[1fr_1fr_1fr_auto] gap-[0.8rem] items-end">
          <div>
            <label className={LBL_CLS}>Restaurant</label>
            <select
              value={restaurantId}
              onChange={(e) => setRestaurantId(e.target.value)}
              className={`${INPUT_CLS} w-full`}
            >
              <option value="">Select restaurant…</option>
              {restaurants.map((r) => {
                const id = r.id || r.restaurant_id;
                return <option key={id} value={id}>{r.business_name || r.name || id}</option>;
              })}
            </select>
          </div>
          <div>
            <label className={LBL_CLS}>Customer WhatsApp Number</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="919876543210"
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div>
            <label className={LBL_CLS}>Customer Name (optional)</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Rahul Sharma"
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <button
            type="button"
            className="btn-p btn-sm bg-violet-600 text-neutral-0 whitespace-nowrap"
            onClick={doCreate}
            disabled={creating}
          >
            {creating ? 'Creating…' : '+ Create Referral'}
          </button>
        </div>
        <div className="cb pt-0">
          <label className={LBL_CLS}>Notes (optional)</label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Customer asked about biryanis on Instagram"
            className={`${INPUT_CLS} w-full`}
          />
          {linkBox && (
            <div className="mt-[0.9rem] bg-ink3 border border-[rgba(124,58,237,0.26)] rounded-lg py-[0.8rem] px-4">
              <div className="text-[0.76rem] text-violet-600 mb-[0.4rem]">
                Referral created — share this restaurant&apos;s WhatsApp link with the customer. Attribution is live for 8 hours.
              </div>
              <div className="flex items-center gap-[0.6rem]">
                <code className="mono flex-1 text-[0.8rem] break-all">{linkBox}</code>
                <button type="button" className="btn-g btn-sm" onClick={copyLink}>Copy Link</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Pending GBREF link requests ─────────────────────────
          Restaurants self-serve a request for a shareable GBREF link via
          the dashboard; admin generates and the request collapses. */}
      <div className="card mb-4">
        <div className="ch justify-between">
          <h3>Pending Link Requests</h3>
          <button type="button" className="btn-g btn-sm" onClick={loadLinkRequests} disabled={loading}>↻ Refresh</button>
        </div>
        {linkRequestsErr ? (
          <div className="cb"><SectionError message={linkRequestsErr} onRetry={loadLinkRequests} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Campaign</th>
                  <th className={TH_CLS}>Requested</th>
                  <th className={TH_CLS}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && linkRequests.length === 0 ? (
                  <tr><td colSpan={4} className={EMPTY_CLS}>Loading…</td></tr>
                ) : linkRequests.length === 0 ? (
                  <tr><td colSpan={4} className={EMPTY_CLS}>No pending link requests</td></tr>
                ) : (
                  linkRequests.map((req) => (
                    <tr key={req._id || req.id} className="border-b border-rim">
                      <td className={TD_CLS}>{req.restaurant_name || req.restaurant_id || '—'}</td>
                      <td className={TD_CLS}>{req.campaign_name || <span className="text-dim">—</span>}</td>
                      <td className={`${TD_CLS} text-[0.78rem] text-dim`}>{timeAgo(req.created_at)}</td>
                      <td className={TD_CLS}>
                        <button
                          type="button"
                          className="btn-p btn-sm bg-violet-600 text-neutral-0"
                          onClick={() => generateForRequest(req)}
                          disabled={!!generating[req._id || '']}
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
        <div className="ch justify-between">
          <h3>All Referrals</h3>
          <button type="button" className="btn-g btn-sm" onClick={loadList} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadList} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={TH_CLS}>Customer Phone</th>
                  <th className={TH_CLS}>Customer Name</th>
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Expires / Expired</th>
                  <th className={TH_CLS}>Orders</th>
                  <th className={TH_CLS}>Order Value</th>
                  <th className={TH_CLS}>Referral Fee (7.5%)</th>
                  <th className={TH_CLS}>Created</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={9} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={9} className={EMPTY_CLS}>No referrals yet</td></tr>
                ) : (
                  rows.map((r) => {
                    const color = STATUS_COLOR[r.status || ''] || 'var(--gb-neutral-500)';
                    return (
                      <tr key={r._id || r.id || `${r.customer_wa_phone}-${r.created_at}`} className="border-b border-rim">
                        <td className={`${TD_CLS} mono`}>{r.customer_wa_phone}</td>
                        <td className={TD_CLS}>{r.customer_name || '—'}</td>
                        <td className={TD_CLS}>{r.restaurant_name}</td>
                        <td className={TD_CLS}>
                          <span
                            className="font-semibold capitalize"
                            // colour from STATUS_COLOR by status at runtime
                            // (active/converted/expired — 3 distinct).
                            style={{ color }}
                          >{r.status}</span>
                        </td>
                        <td className={`${TD_CLS} text-[0.78rem]`}>
                          {r.status === 'active' ? (
                            <span className="text-[#22c55e]">Expires {timeUntil(r.expires_at)}</span>
                          ) : (
                            fmtDate(r.expires_at)
                          )}
                        </td>
                        <td className={TD_CLS}>{r.orders_count}</td>
                        <td className={TD_CLS}>₹{fmtInr(r.total_order_value_rs)}</td>
                        <td className={`${TD_CLS} font-semibold text-[#a78bfa]`}>
                          ₹{fmtInr(r.referral_fee_rs)}
                        </td>
                        <td className={`${TD_CLS} text-[0.78rem]`}>{fmtDate(r.created_at)}</td>
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
