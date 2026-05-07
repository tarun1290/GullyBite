'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getAdminRestaurants,
  getAdminCoupons,
  createAdminCoupon,
  patchAdminCoupon,
} from '../../../api/admin';

interface RestaurantLite { id: string; name: string }

interface RestaurantApiRow {
  id?: string;
  _id?: string;
  restaurant_id?: string;
  business_name?: string;
  name?: string;
}

interface RestaurantsListEnvelope {
  items?: RestaurantApiRow[];
  restaurants?: RestaurantApiRow[];
}

interface CouponCode {
  id: string;
  code?: string;
  description?: string;
  discount_type?: 'percent' | 'flat' | 'free_delivery' | string;
  discount_value?: number | string;
  max_discount_rs?: number | string;
  valid_from?: string;
  valid_until?: string;
  usage_count?: number;
  usage_limit?: number;
  is_active?: boolean;
}

interface CouponsResponse { items?: CouponCode[] }

interface MsgState { type: 'error' | 'success' | 'info'; text: string }

function fmtDateISO(d?: string): string {
  return d ? new Date(d).toISOString().slice(0, 10) : '—';
}

function discLabel(c: CouponCode): string {
  if (c.discount_type === 'percent') {
    return `${c.discount_value}%${c.max_discount_rs ? ` (up to ₹${c.max_discount_rs})` : ''}`;
  }
  if (c.discount_type === 'free_delivery') return 'Free delivery';
  return `₹${c.discount_value}`;
}

const TABLE_CLS = 'w-full border-collapse text-[0.82rem]';
const TR_HEAD_CLS = 'bg-ink border-b border-rim';
const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.55rem] px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.45rem] px-[0.7rem] text-[0.85rem]';
const LBL_CLS = 'text-[0.75rem] text-dim font-semibold block mb-1';
const STAR_CLS = 'text-red-500';

export default function AdminCouponCodesPage() {
  const { showToast } = useToast();
  const [restaurants, setRestaurants] = useState<RestaurantLite[]>([]);
  const [restaurantsErr, setRestaurantsErr] = useState<string | null>(null);
  const [restaurantId, setRestaurantId] = useState<string>('');
  const [rows, setRows] = useState<CouponCode[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [togglingId, setTogglingId] = useState<string>('');

  const [code, setCode] = useState<string>('');
  const [type, setType] = useState<string>('flat');
  const [value, setValue] = useState<string>('');
  const [desc, setDesc] = useState<string>('');
  const [min, setMin] = useState<string>('');
  const [cap, setCap] = useState<string>('');
  const [limit, setLimit] = useState<string>('');
  const [validFrom, setValidFrom] = useState<string>('');
  const [validUntil, setValidUntil] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [msg, setMsg] = useState<MsgState | null>(null);

  const loadRestaurants = useCallback(async () => {
    try {
      const list = (await getAdminRestaurants()) as RestaurantApiRow[] | RestaurantsListEnvelope | null;
      const items: RestaurantApiRow[] = Array.isArray(list)
        ? list
        : (list?.items || list?.restaurants || []);
      const mapped: RestaurantLite[] = items
        .map((r) => ({ id: (r.id || r._id || r.restaurant_id) || '', name: r.business_name || r.name || r.id || r._id || '' }))
        .filter((r) => r.id)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      setRestaurants(mapped);
      setRestaurantsErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRestaurantsErr(er?.response?.data?.error || er?.message || 'Failed to load restaurants');
    }
  }, []);

  const loadCoupons = useCallback(async () => {
    if (!restaurantId) { setRows([]); setListErr(null); return; }
    setLoading(true);
    try {
      const res = (await getAdminCoupons(restaurantId)) as CouponsResponse | null;
      setRows(res?.items || []);
      setListErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRows([]);
      setListErr(er?.response?.data?.error || er?.message || 'Failed to load coupons');
    } finally {
      setLoading(false);
    }
  }, [restaurantId]);

  useEffect(() => { loadRestaurants(); }, [loadRestaurants]);
  useEffect(() => { loadCoupons(); }, [loadCoupons]);

  const resetForm = () => {
    setCode(''); setDesc(''); setValue(''); setMin(''); setCap('');
    setLimit(''); setValidFrom(''); setValidUntil(''); setType('flat'); setMsg(null);
  };

  const toggleActive = async (id: string, nextActive: boolean) => {
    setTogglingId(id);
    try {
      await patchAdminCoupon(id, { is_active: nextActive });
      loadCoupons();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Update failed', 'error');
    } finally {
      setTogglingId('');
    }
  };

  const submit = async () => {
    setMsg(null);
    if (!restaurantId) { setMsg({ type: 'error', text: 'Select a restaurant first' }); return; }
    const upCode = code.trim().toUpperCase();
    if (!upCode) { setMsg({ type: 'error', text: 'Code required' }); return; }
    const num = parseFloat(value);
    if (type !== 'free_delivery' && !(num > 0)) {
      setMsg({ type: 'error', text: 'Value must be > 0' });
      return;
    }
    const body = {
      restaurant_id: restaurantId,
      code: upCode,
      description: desc.trim(),
      discount_type: type,
      discount_value: type === 'free_delivery' ? 0 : num,
      min_order_rs:    min  === '' ? null : parseFloat(min),
      max_discount_rs: cap  === '' ? null : parseFloat(cap),
      usage_limit:     limit === '' ? null : parseInt(limit, 10),
      valid_from:  validFrom  || null,
      valid_until: validUntil || null,
      is_active: true,
    };
    setSubmitting(true);
    setMsg({ type: 'info', text: 'Creating…' });
    try {
      await createAdminCoupon(body);
      setMsg({ type: 'success', text: 'Created.' });
      showToast('Coupon created', 'success');
      resetForm();
      loadCoupons();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setMsg({ type: 'error', text: er?.response?.data?.error || er?.message || 'Create failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const msgCls = msg
    ? msg.type === 'error' ? 'text-red-500' : msg.type === 'success' ? 'text-[#059669]' : 'text-dim'
    : '';

  return (
    <div id="pg-coupon-codes">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-[0.8rem] text-dim">Restaurant:</label>
        <select
          value={restaurantId}
          onChange={(e) => setRestaurantId(e.target.value)}
          className={`${INPUT_CLS} flex-1 max-w-[340px]`}
        >
          <option value="">— Select restaurant —</option>
          {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button type="button" className="btn-g btn-sm" onClick={loadCoupons} disabled={!restaurantId || loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {restaurantsErr && (
        <div className="mb-4">
          <SectionError message={restaurantsErr} onRetry={loadRestaurants} />
        </div>
      )}

      <div className="card mb-4">
        <div className="ch"><h3>Coupons</h3></div>
        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadCoupons} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE_CLS}>
              <thead>
                <tr className={TR_HEAD_CLS}>
                  <th className={TH_CLS}>Code</th>
                  <th className={TH_CLS}>Description</th>
                  <th className={TH_CLS}>Discount</th>
                  <th className={TH_CLS}>Validity</th>
                  <th className={TH_CLS}>Uses</th>
                  <th className={TH_CLS}>Active</th>
                  <th className={TH_CLS}></th>
                </tr>
              </thead>
              <tbody>
                {!restaurantId ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>Select a restaurant to view coupons</td></tr>
                ) : loading ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} className={EMPTY_CLS}>No coupons yet</td></tr>
                ) : rows.map((c) => {
                  const active = Boolean(c.is_active);
                  return (
                    <tr key={c.id} className="border-b border-rim">
                      <td className={`${TD_CLS} font-semibold mono`}>{c.code}</td>
                      <td className={`${TD_CLS} text-[0.8rem]`}>{c.description || '—'}</td>
                      <td className={`${TD_CLS} text-[0.8rem]`}>{discLabel(c)}</td>
                      <td className={`${TD_CLS} text-[0.75rem] text-dim`}>
                        {fmtDateISO(c.valid_from)} → {fmtDateISO(c.valid_until)}
                      </td>
                      <td className={`${TD_CLS} text-[0.8rem]`}>
                        {c.usage_count || 0}{c.usage_limit ? ` / ${c.usage_limit}` : ''}
                      </td>
                      <td className={TD_CLS}>
                        <span className={`inline-block py-[0.15rem] px-[0.55rem] rounded-[10px] text-[0.72rem] font-semibold ${active ? 'bg-[#d1fae5] text-[#059669]' : 'bg-red-100 text-red-500'}`}>{active ? 'ACTIVE' : 'INACTIVE'}</span>
                      </td>
                      <td className={TD_CLS}>
                        <button
                          type="button"
                          className="btn-g btn-sm"
                          onClick={() => toggleActive(c.id, !active)}
                          disabled={togglingId === c.id}
                        >
                          {togglingId === c.id ? '…' : active ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="ch"><h3>Create Coupon</h3></div>
        <div className="cb grid grid-cols-3 gap-[0.85rem]">
          <div>
            <label className={LBL_CLS}>Code <span className={STAR_CLS}>*</span></label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={20}
              placeholder="SAVE20"
              className={`${INPUT_CLS} w-full uppercase`}
            />
          </div>
          <div>
            <label className={LBL_CLS}>Discount Type <span className={STAR_CLS}>*</span></label>
            <select value={type} onChange={(e) => setType(e.target.value)} className={`${INPUT_CLS} w-full`}>
              <option value="flat">Flat (₹)</option>
              <option value="percent">Percent (%)</option>
              <option value="free_delivery">Free Delivery</option>
            </select>
          </div>
          <div>
            <label className={LBL_CLS}>Value <span className={STAR_CLS}>*</span></label>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type="number"
              min={0}
              step={1}
              disabled={type === 'free_delivery'}
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div className="col-span-3">
            <label className={LBL_CLS}>Description (shown to customer)</label>
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="₹50 off on orders above ₹299"
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div>
            <label className={LBL_CLS}>Min Order (₹)</label>
            <input
              value={min}
              onChange={(e) => setMin(e.target.value)}
              type="number"
              min={0}
              step={1}
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div>
            <label className={LBL_CLS}>Max Discount Cap (₹, percent only)</label>
            <input
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              type="number"
              min={0}
              step={1}
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div>
            <label className={LBL_CLS}>Usage Limit</label>
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              type="number"
              min={0}
              step={1}
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div>
            <label className={LBL_CLS}>Valid From</label>
            <input
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              type="date"
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div>
            <label className={LBL_CLS}>Valid Until</label>
            <input
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              type="date"
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div className="col-span-3 flex justify-end gap-2">
            <button type="button" className="btn-g btn-sm" onClick={resetForm} disabled={submitting}>Reset</button>
            <button type="button" className="btn-p btn-sm" onClick={submit} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Coupon'}
            </button>
          </div>
          {msg && (
            <div className={`col-span-3 text-[0.8rem] ${msgCls}`}>
              {msg.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
