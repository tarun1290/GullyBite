'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getAdminRestaurants,
  getAdminCoupons,
  createAdminCoupon,
  patchAdminCoupon,
  deleteAdminCoupon,
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

type DiscountType = 'percent' | 'flat';

interface CouponCode {
  id: string;
  code?: string;
  description?: string;
  discount_type?: DiscountType | string;
  discount_value?: number | string;
  min_order_rs?: number | string;
  max_discount_rs?: number | string | null;
  valid_from?: string;
  valid_until?: string;
  usage_count?: number;
  usage_limit?: number | null;
  per_user_limit?: number | null;
  first_order_only?: boolean;
  restaurant_id?: string | null;
  is_active?: boolean;
}

interface CouponsResponse { items?: CouponCode[] }

interface MsgState { type: 'error' | 'success' | 'info'; text: string }

type Scope = 'restaurant' | 'platform';

function fmtDateISO(d?: string): string {
  return d ? new Date(d).toISOString().slice(0, 10) : '—';
}

function toDateInput(d?: string): string {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

function discLabel(c: CouponCode): string {
  if (c.discount_type === 'percent') {
    return `${c.discount_value}%${c.max_discount_rs ? ` (up to ₹${c.max_discount_rs})` : ''}`;
  }
  if (c.discount_type === 'flat') {
    return `₹${c.discount_value}`;
  }
  // Anything else (e.g. legacy free_delivery rows in the DB) renders as
  // a placeholder rather than a misleading rupee/percentage label.
  return 'Legacy';
}

const TABLE_CLS = 'w-full border-collapse text-sm';
const TR_HEAD_CLS = 'bg-ink border-b border-rim';
const TH_CLS = 'py-2.5 px-3 text-left text-xs text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2 px-3 align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-2 px-3 text-base';
const LBL_CLS = 'text-xs text-dim font-semibold block mb-1';
const STAR_CLS = 'text-red-500';

export default function AdminCouponCodesPage() {
  const { showToast } = useToast();
  const [restaurants, setRestaurants] = useState<RestaurantLite[]>([]);
  const [restaurantsErr, setRestaurantsErr] = useState<string | null>(null);
  const [restaurantId, setRestaurantId] = useState<string>('');
  const [scope, setScope] = useState<Scope>('restaurant');
  const [rows, setRows] = useState<CouponCode[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [togglingId, setTogglingId] = useState<string>('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>('');
  const [deletingId, setDeletingId] = useState<string>('');

  const [code, setCode] = useState<string>('');
  const [type, setType] = useState<DiscountType>('flat');
  const [value, setValue] = useState<string>('');
  const [desc, setDesc] = useState<string>('');
  const [min, setMin] = useState<string>('');
  const [cap, setCap] = useState<string>('');
  const [limit, setLimit] = useState<string>('');
  const [perUserLimit, setPerUserLimit] = useState<string>('');
  const [firstOrderOnly, setFirstOrderOnly] = useState<boolean>(false);
  const [validFrom, setValidFrom] = useState<string>('');
  const [validUntil, setValidUntil] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [msg, setMsg] = useState<MsgState | null>(null);
  const [valueErr, setValueErr] = useState<string | null>(null);

  // Edit-mode state. editingId === '' → create mode; otherwise PATCH.
  const [editingId, setEditingId] = useState<string>('');
  const [editingCoupon, setEditingCoupon] = useState<CouponCode | null>(null);

  const isEditing = editingId !== '';
  const isPercent = type === 'percent';
  const isPlatform = scope === 'platform';

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

  // Loads restaurant-scoped coupons when a restaurant is picked. The
  // platform-wide list path needs a different backend endpoint that is
  // currently shadowed (see backend audit) — until that is fixed we
  // simply blank the table and surface a hint.
  const loadCoupons = useCallback(async () => {
    if (scope === 'platform') {
      setRows([]);
      setListErr(null);
      return;
    }
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
  }, [restaurantId, scope]);

  useEffect(() => { loadRestaurants(); }, [loadRestaurants]);
  useEffect(() => { loadCoupons(); }, [loadCoupons]);

  const resetForm = () => {
    setCode(''); setDesc(''); setValue(''); setMin(''); setCap('');
    setLimit(''); setPerUserLimit(''); setFirstOrderOnly(false);
    setValidFrom(''); setValidUntil(''); setType('flat');
    setMsg(null); setValueErr(null);
  };

  const cancelEdit = () => {
    setEditingId('');
    setEditingCoupon(null);
    resetForm();
  };

  // Both flat and percent honour value, min, and cap. No type-specific
  // resets needed; just clear the inline value error.
  const onTypeChange = (next: DiscountType) => {
    setType(next);
    setValueErr(null);
  };

  const startEdit = (c: CouponCode) => {
    setEditingId(c.id);
    setEditingCoupon(c);
    setCode(c.code || '');
    // Legacy rows (e.g. free_delivery) fall back to 'flat' so the form
    // doesn't end up in an invalid type state. Type/value/code are
    // immutable in edit mode anyway.
    setType(c.discount_type === 'percent' ? 'percent' : 'flat');
    setValue(c.discount_value != null ? String(c.discount_value) : '');
    setDesc(c.description || '');
    setMin(c.min_order_rs != null ? String(c.min_order_rs) : '');
    setCap(c.max_discount_rs != null ? String(c.max_discount_rs) : '');
    setLimit(c.usage_limit != null ? String(c.usage_limit) : '');
    setPerUserLimit(c.per_user_limit != null ? String(c.per_user_limit) : '');
    setFirstOrderOnly(!!c.first_order_only);
    setValidFrom(toDateInput(c.valid_from));
    setValidUntil(toDateInput(c.valid_until));
    setMsg(null);
    setValueErr(null);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
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

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteAdminCoupon(id);
      showToast('Coupon deleted', 'success');
      setConfirmDeleteId('');
      if (editingId === id) cancelEdit();
      loadCoupons();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Delete failed', 'error');
    } finally {
      setDeletingId('');
    }
  };

  const submit = async () => {
    setMsg(null);
    setValueErr(null);

    if (isEditing) {
      // PATCH path — admin backend's allowed list currently is
      //   is_active, description, valid_from, valid_until, usage_limit, per_user_limit
      // and silently ignores anything else. We additionally send
      // max_discount_rs because operators need to adjust the per-order
      // cap on existing coupons (both percent and flat). If the admin
      // PATCH handler hasn't yet been extended to accept it, the field
      // is simply dropped server-side — no error.
      // Edit-mode validation matches create: min ≥ 0, cap > 0 — both are
      // required for flat and percent.
      const minNum = parseFloat(min);
      if (min === '' || Number.isNaN(minNum) || minNum < 0) {
        setMsg({ type: 'error', text: 'Min order must be ≥ 0' });
        return;
      }
      const capNum = parseFloat(cap);
      if (cap === '' || Number.isNaN(capNum) || !(capNum > 0)) {
        setMsg({ type: 'error', text: 'Max discount per order must be > 0' });
        return;
      }
      const body: Record<string, unknown> = {
        description: desc.trim() || null,
        valid_from: validFrom || null,
        valid_until: validUntil || null,
        usage_limit: limit === '' ? null : parseInt(limit, 10),
        per_user_limit: perUserLimit === '' ? null : parseInt(perUserLimit, 10),
        min_order_rs: minNum,
        max_discount_rs: capNum,
      };
      setSubmitting(true);
      setMsg({ type: 'info', text: 'Saving…' });
      try {
        await patchAdminCoupon(editingId, body);
        setMsg({ type: 'success', text: 'Saved.' });
        showToast('Coupon updated', 'success');
        cancelEdit();
        loadCoupons();
      } catch (e: unknown) {
        const er = e as { response?: { data?: { error?: string } }; message?: string };
        setMsg({ type: 'error', text: er?.response?.data?.error || er?.message || 'Update failed' });
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // CREATE path
    if (scope === 'restaurant' && !restaurantId) {
      setMsg({ type: 'error', text: 'Select a restaurant first' });
      return;
    }
    const upCode = code.trim().toUpperCase();
    if (!upCode) { setMsg({ type: 'error', text: 'Code required' }); return; }
    const num = parseFloat(value);
    if (!(num > 0)) {
      setValueErr('Value must be > 0');
      return;
    }
    if (type === 'percent' && num > 100) {
      setValueErr('Percentage cannot exceed 100');
      return;
    }
    const minNum = parseFloat(min);
    if (min === '' || Number.isNaN(minNum) || minNum < 0) {
      setMsg({ type: 'error', text: 'Min order must be ≥ 0' });
      return;
    }
    const capNum = parseFloat(cap);
    if (cap === '' || Number.isNaN(capNum) || !(capNum > 0)) {
      setMsg({ type: 'error', text: 'Max discount per order must be > 0' });
      return;
    }
    const body = {
      restaurant_id: scope === 'platform' ? null : restaurantId,
      code: upCode,
      description: desc.trim(),
      discount_type: type,
      discount_value: num,
      min_order_rs: minNum,
      max_discount_rs: capNum,
      usage_limit:     limit === '' ? null : parseInt(limit, 10),
      per_user_limit:  perUserLimit === '' ? null : parseInt(perUserLimit, 10),
      first_order_only: firstOrderOnly,
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
    ? msg.type === 'error' ? 'text-red-500' : msg.type === 'success' ? 'text-emerald-600' : 'text-dim'
    : '';

  return (
    <div id="pg-coupon-codes">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-sm text-dim">Scope:</label>
        <div className="inline-flex rounded-md border border-rim overflow-hidden">
          <button
            type="button"
            className={`text-sm py-1.5 px-3.5 ${scope === 'restaurant' ? 'bg-acc text-white' : 'bg-neutral-0 text-dim'}`}
            onClick={() => setScope('restaurant')}
          >
            Restaurant
          </button>
          <button
            type="button"
            className={`text-sm py-1.5 px-3.5 border-l border-rim ${scope === 'platform' ? 'bg-acc text-white' : 'bg-neutral-0 text-dim'}`}
            onClick={() => setScope('platform')}
          >
            Platform-wide
          </button>
        </div>

        {scope === 'restaurant' && (
          <>
            <label className="text-sm text-dim ml-2">Restaurant:</label>
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
          </>
        )}
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
                  <th className={TH_CLS}>Scope</th>
                  <th className={TH_CLS}>Description</th>
                  <th className={TH_CLS}>Discount</th>
                  <th className={TH_CLS}>Validity</th>
                  <th className={TH_CLS}>Uses</th>
                  <th className={TH_CLS}>Active</th>
                  <th className={TH_CLS}></th>
                </tr>
              </thead>
              <tbody>
                {scope === 'platform' ? (
                  <tr><td colSpan={8} className={EMPTY_CLS}>Platform-wide listing is not available yet — use this form to create platform coupons (restaurant_id is null on the doc).</td></tr>
                ) : !restaurantId ? (
                  <tr><td colSpan={8} className={EMPTY_CLS}>Select a restaurant to view coupons</td></tr>
                ) : loading ? (
                  <tr><td colSpan={8} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8} className={EMPTY_CLS}>No coupons yet</td></tr>
                ) : rows.map((c) => {
                  const active = Boolean(c.is_active);
                  const isPlatformWide = c.restaurant_id == null;
                  const isConfirmingDelete = confirmDeleteId === c.id;
                  const isDeleting = deletingId === c.id;
                  return (
                    <tr key={c.id} className="border-b border-rim">
                      <td className={`${TD_CLS} font-semibold mono`}>{c.code}</td>
                      <td className={TD_CLS}>
                        {isPlatformWide ? (
                          <span className="inline-block py-0.5 px-2 rounded-r text-xs font-semibold bg-blue-100 text-blue-800">
                            Platform-wide
                          </span>
                        ) : (
                          <span className="text-sm text-dim">Restaurant</span>
                        )}
                      </td>
                      <td className={`${TD_CLS} text-sm`}>{c.description || '—'}</td>
                      <td className={`${TD_CLS} text-sm`}>{discLabel(c)}</td>
                      <td className={`${TD_CLS} text-xs text-dim`}>
                        {fmtDateISO(c.valid_from)} → {fmtDateISO(c.valid_until)}
                      </td>
                      <td className={`${TD_CLS} text-sm`}>
                        {c.usage_count || 0}{c.usage_limit ? ` / ${c.usage_limit}` : ''}
                      </td>
                      <td className={TD_CLS}>
                        <span className={`inline-block py-0.5 px-2 rounded-r text-xs font-semibold ${active ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-500'}`}>{active ? 'ACTIVE' : 'INACTIVE'}</span>
                      </td>
                      <td className={`${TD_CLS} flex gap-2 flex-wrap`}>
                        <button
                          type="button"
                          className="btn-g btn-sm"
                          onClick={() => startEdit(c)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn-g btn-sm"
                          onClick={() => toggleActive(c.id, !active)}
                          disabled={togglingId === c.id}
                        >
                          {togglingId === c.id ? '…' : active ? 'Deactivate' : 'Activate'}
                        </button>
                        {isConfirmingDelete ? (
                          <>
                            <button
                              type="button"
                              className="btn-g btn-sm"
                              disabled={isDeleting}
                              onClick={() => setConfirmDeleteId('')}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="btn-sm py-1 px-2.5 text-sm rounded-md bg-red-100 text-red-700 font-semibold"
                              disabled={isDeleting}
                              onClick={() => handleDelete(c.id)}
                            >
                              {isDeleting ? '…' : `Delete coupon ${c.code || ''}? This cannot be undone.`}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn-sm py-1 px-2.5 text-sm rounded-md bg-red-50 text-red-600 font-semibold"
                            onClick={() => setConfirmDeleteId(c.id)}
                          >
                            Delete
                          </button>
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

      <div className="card">
        <div className="ch flex items-center justify-between">
          <h3>{isEditing ? `Edit Coupon — ${editingCoupon?.code || ''}` : 'Create Coupon'}</h3>
          {isEditing && (
            <button type="button" className="btn-g btn-sm" onClick={cancelEdit}>Cancel</button>
          )}
        </div>
        <div className="cb grid grid-cols-3 gap-3.5">
          <div>
            <label className={LBL_CLS}>Code <span className={STAR_CLS}>*</span></label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={20}
              placeholder="SAVE20"
              className={`${INPUT_CLS} w-full uppercase disabled:opacity-60 disabled:cursor-not-allowed`}
              disabled={isEditing}
              readOnly={isEditing}
            />
          </div>
          <div>
            <label className={LBL_CLS}>Discount Type <span className={STAR_CLS}>*</span></label>
            <select
              value={type}
              onChange={(e) => onTypeChange(e.target.value as DiscountType)}
              className={`${INPUT_CLS} w-full disabled:opacity-60 disabled:cursor-not-allowed`}
              disabled={isEditing}
            >
              <option value="flat">Flat (₹)</option>
              <option value="percent">Percent (%)</option>
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
              {...(isPercent ? { max: 100 } : {})}
              disabled={isEditing}
              className={`${INPUT_CLS} w-full disabled:opacity-60 disabled:cursor-not-allowed`}
            />
            {valueErr && <div className="mt-1 text-xs text-red-500">{valueErr}</div>}
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
            <label className={LBL_CLS}>Min Order (₹) <span className={STAR_CLS}>*</span></label>
            <input
              value={min}
              onChange={(e) => setMin(e.target.value)}
              type="number"
              min={0}
              step={1}
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          {/* Per-order discount cap — required for both percent and flat. */}
          <div>
            <label className={LBL_CLS}>Max discount per order (₹) <span className={STAR_CLS}>*</span></label>
            <input
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              type="number"
              min={1}
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
              placeholder="Leave blank = unlimited"
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div>
            <label className={LBL_CLS}>Uses per customer</label>
            <input
              value={perUserLimit}
              onChange={(e) => setPerUserLimit(e.target.value)}
              type="number"
              min={0}
              step={1}
              placeholder="Leave blank for unlimited"
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 text-base select-none">
              <input
                type="checkbox"
                className="h-4 w-4 disabled:opacity-60 disabled:cursor-not-allowed"
                checked={firstOrderOnly}
                onChange={(e) => setFirstOrderOnly(e.target.checked)}
                disabled={isEditing}
              />
              First order only
            </label>
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
            <button type="button" className="btn-g btn-sm" onClick={isEditing ? cancelEdit : resetForm} disabled={submitting}>
              {isEditing ? 'Cancel' : 'Reset'}
            </button>
            <button type="button" className="btn-p btn-sm" onClick={submit} disabled={submitting}>
              {submitting
                ? (isEditing ? 'Saving…' : 'Creating…')
                : (isEditing ? 'Save Changes' : 'Create Coupon')}
            </button>
          </div>
          {msg && (
            <div className={`col-span-3 text-sm ${msgCls}`}>
              {msg.text}
            </div>
          )}
          {isPlatform && !isEditing && (
            <div className="col-span-3 text-sm text-dim">
              Creating a platform-wide coupon — restaurant_id will be null on the saved doc.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
