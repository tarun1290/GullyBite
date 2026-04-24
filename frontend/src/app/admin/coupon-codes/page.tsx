'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/dashboard/analytics/SectionError';
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

const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' };
const trHead: CSSProperties = { background: 'var(--ink)', borderBottom: '1px solid var(--rim)' };
const th: CSSProperties = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td: CSSProperties = { padding: '.55rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input: CSSProperties = { background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 6, padding: '.45rem .7rem', fontSize: '.85rem' };
const lbl: CSSProperties = { fontSize: '.75rem', color: 'var(--dim)', fontWeight: 600, display: 'block', marginBottom: '.25rem' };
const star: CSSProperties = { color: 'var(--gb-red-500)' };

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

  return (
    <div id="pg-coupon-codes">
      <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '.8rem', color: 'var(--dim)' }}>Restaurant:</label>
        <select
          value={restaurantId}
          onChange={(e) => setRestaurantId(e.target.value)}
          style={{ ...input, flex: 1, maxWidth: 340 }}
        >
          <option value="">— Select restaurant —</option>
          {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button type="button" className="btn-g btn-sm" onClick={loadCoupons} disabled={!restaurantId || loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {restaurantsErr && (
        <div style={{ marginBottom: '1rem' }}>
          <SectionError message={restaurantsErr} onRetry={loadRestaurants} />
        </div>
      )}

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch"><h3>Coupons</h3></div>
        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadCoupons} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr style={trHead}>
                  <th style={th}>Code</th>
                  <th style={th}>Description</th>
                  <th style={th}>Discount</th>
                  <th style={th}>Validity</th>
                  <th style={th}>Uses</th>
                  <th style={th}>Active</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {!restaurantId ? (
                  <tr><td colSpan={7} style={emptyCell}>Select a restaurant to view coupons</td></tr>
                ) : loading ? (
                  <tr><td colSpan={7} style={emptyCell}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} style={emptyCell}>No coupons yet</td></tr>
                ) : rows.map((c) => {
                  const active = Boolean(c.is_active);
                  return (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td style={{ ...td, fontWeight: 600 }} className="mono">{c.code}</td>
                      <td style={{ ...td, fontSize: '.8rem' }}>{c.description || '—'}</td>
                      <td style={{ ...td, fontSize: '.8rem' }}>{discLabel(c)}</td>
                      <td style={{ ...td, fontSize: '.75rem', color: 'var(--dim)' }}>
                        {fmtDateISO(c.valid_from)} → {fmtDateISO(c.valid_until)}
                      </td>
                      <td style={{ ...td, fontSize: '.8rem' }}>
                        {c.usage_count || 0}{c.usage_limit ? ` / ${c.usage_limit}` : ''}
                      </td>
                      <td style={td}>
                        <span style={{
                          display: 'inline-block', padding: '.15rem .55rem', borderRadius: 10,
                          fontSize: '.72rem', fontWeight: 600,
                          background: active ? '#d1fae5' : 'var(--gb-red-100)',
                          color: active ? '#059669' : 'var(--gb-red-500)',
                        }}>{active ? 'ACTIVE' : 'INACTIVE'}</span>
                      </td>
                      <td style={td}>
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
        <div className="cb" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '.85rem' }}>
          <div>
            <label style={lbl}>Code <span style={star}>*</span></label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={20}
              placeholder="SAVE20"
              style={{ ...input, width: '100%', textTransform: 'uppercase' }}
            />
          </div>
          <div>
            <label style={lbl}>Discount Type <span style={star}>*</span></label>
            <select value={type} onChange={(e) => setType(e.target.value)} style={{ ...input, width: '100%' }}>
              <option value="flat">Flat (₹)</option>
              <option value="percent">Percent (%)</option>
              <option value="free_delivery">Free Delivery</option>
            </select>
          </div>
          <div>
            <label style={lbl}>Value <span style={star}>*</span></label>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type="number"
              min={0}
              step={1}
              disabled={type === 'free_delivery'}
              style={{ ...input, width: '100%' }}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lbl}>Description (shown to customer)</label>
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="₹50 off on orders above ₹299"
              style={{ ...input, width: '100%' }}
            />
          </div>
          <div>
            <label style={lbl}>Min Order (₹)</label>
            <input
              value={min}
              onChange={(e) => setMin(e.target.value)}
              type="number"
              min={0}
              step={1}
              style={{ ...input, width: '100%' }}
            />
          </div>
          <div>
            <label style={lbl}>Max Discount Cap (₹, percent only)</label>
            <input
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              type="number"
              min={0}
              step={1}
              style={{ ...input, width: '100%' }}
            />
          </div>
          <div>
            <label style={lbl}>Usage Limit</label>
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              type="number"
              min={0}
              step={1}
              style={{ ...input, width: '100%' }}
            />
          </div>
          <div>
            <label style={lbl}>Valid From</label>
            <input
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              type="date"
              style={{ ...input, width: '100%' }}
            />
          </div>
          <div>
            <label style={lbl}>Valid Until</label>
            <input
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              type="date"
              style={{ ...input, width: '100%' }}
            />
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: '.5rem' }}>
            <button type="button" className="btn-g btn-sm" onClick={resetForm} disabled={submitting}>Reset</button>
            <button type="button" className="btn-p btn-sm" onClick={submit} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Coupon'}
            </button>
          </div>
          {msg && (
            <div style={{
              gridColumn: '1 / -1', fontSize: '.8rem',
              color: msg.type === 'error' ? 'var(--gb-red-500)' : msg.type === 'success' ? '#059669' : 'var(--dim)',
            }}>
              {msg.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
