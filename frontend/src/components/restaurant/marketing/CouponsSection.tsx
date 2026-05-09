'use client';

import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import { useToast } from '../../Toast';
import {
  getCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  getBranches,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

type DiscountType = 'percent' | 'flat';

interface CouponForm {
  code: string;
  type: DiscountType;
  value: string;
  min: string;
  maxdis: string;
  limit: string;
  perUserLimit: string;
  firstOrderOnly: boolean;
  branchIds: string[];
  from: string;
  until: string;
  desc: string;
}

interface Coupon {
  id: string;
  code: string;
  description?: string;
  discount_type?: DiscountType | string;
  discount_value: number | string;
  min_order_rs?: number | string;
  max_discount_rs?: number | string | null;
  usage_limit?: number | null;
  usage_count?: number;
  per_user_limit?: number | null;
  first_order_only?: boolean;
  branch_ids?: string[] | null;
  valid_from?: string;
  valid_until?: string;
  is_active?: boolean;
}

const EMPTY_FORM: CouponForm = {
  code: '',
  type: 'percent',
  value: '',
  min: '',
  maxdis: '',
  limit: '',
  perUserLimit: '',
  firstOrderOnly: false,
  branchIds: [],
  from: '',
  until: '',
  desc: '',
};

function formatDate(d?: string): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function toDateInput(d?: string): string {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

function discountLabel(c: Coupon): string {
  if (c.discount_type === 'percent') {
    const pct = `${parseFloat(String(c.discount_value)).toFixed(0)}%`;
    return c.max_discount_rs
      ? `${pct} (max ₹${parseFloat(String(c.max_discount_rs)).toFixed(0)})`
      : pct;
  }
  if (c.discount_type === 'flat') {
    return `₹${parseFloat(String(c.discount_value)).toFixed(0)} flat`;
  }
  // Anything else (e.g. legacy free_delivery rows in the DB) renders as
  // a placeholder rather than a misleading rupee/percentage label.
  return 'Legacy';
}

interface CouponRowProps {
  coupon: Coupon;
  onChanged?: (() => void) | undefined;
  onEdit: (c: Coupon) => void;
}

function CouponRow({ coupon, onChanged, onEdit }: CouponRowProps) {
  const { showToast } = useToast();
  const [toggling, setToggling] = useState<boolean>(false);
  const [confirmDel, setConfirmDel] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const isActive = Boolean(coupon.is_active);

  const handleToggle = async () => {
    if (toggling) return;
    setToggling(true);
    try {
      await updateCoupon(coupon.id, { isActive: !isActive });
      showToast(!isActive ? 'Coupon enabled' : 'Coupon disabled', 'success');
      onChanged?.();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Toggle failed', 'error');
    } finally {
      setToggling(false);
    }
  };

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteCoupon(coupon.id);
      showToast('Coupon deleted', 'success');
      onChanged?.();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
      setConfirmDel(false);
    } finally {
      setDeleting(false);
    }
  };

  const validFrom = formatDate(coupon.valid_from);
  const validUntil = formatDate(coupon.valid_until);
  const usedLabel = coupon.usage_limit
    ? `${coupon.usage_count ?? 0} / ${coupon.usage_limit}`
    : `${coupon.usage_count ?? 0} / ∞`;

  return (
    <tr className="border-b border-rim">
      <td className="py-[0.65rem] px-4 font-mono font-bold tracking-wider">
        {coupon.code}
      </td>
      <td className="py-[0.65rem] px-4">{discountLabel(coupon)}</td>
      <td className="py-[0.65rem] px-4">₹{parseFloat(String(coupon.min_order_rs || 0)).toFixed(0)}</td>
      <td className="py-[0.65rem] px-4">{usedLabel}</td>
      <td className="py-[0.65rem] px-4 text-[0.8rem]">
        {validFrom} → {validUntil}
      </td>
      <td className="py-[0.65rem] px-4">
        <span className={`text-[0.78rem] font-semibold ${isActive ? 'text-[#22c55e]' : 'text-[#6b7280]'}`}>
          {isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td className="py-[0.65rem] px-4 flex gap-3">
        <button
          type="button"
          className="btn-g btn-xs"
          onClick={() => onEdit(coupon)}
        >
          Edit
        </button>
        <button
          type="button"
          className={`btn btn-sm py-1 px-[0.6rem] text-[0.78rem] ${isActive ? 'bg-[#374151]' : 'bg-acc'}`}
          disabled={toggling}
          onClick={handleToggle}
        >
          {toggling ? '…' : isActive ? 'Disable' : 'Enable'}
        </button>
        {confirmDel ? (
          <>
            <button
              type="button"
              className="btn-g btn-xs"
              disabled={deleting}
              onClick={() => setConfirmDel(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-p btn-xs bg-[#7f1d1d] text-[#fca5a5]"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? '…' : 'Confirm'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn-p btn-xs bg-[#7f1d1d] text-[#fca5a5]"
            onClick={() => setConfirmDel(true)}
          >
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}

export default function CouponsSection() {
  const { showToast } = useToast();
  const [form, setForm] = useState<CouponForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  // editingId === null → create mode, else PATCH the matching coupon
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingCoupon, setEditingCoupon] = useState<Coupon | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);

  const { data, loading, error, refetch } = useAnalyticsFetch<Coupon[] | null>(
    useCallback(() => getCoupons() as Promise<Coupon[] | null>, []),
    [],
  );

  // One-shot branches fetch — used to render the "Limit to branches"
  // checkbox group. Failure is non-fatal: we just hide the control.
  useEffect(() => {
    let cancelled = false;
    getBranches()
      .then((rows) => { if (!cancelled) setBranches(rows || []); })
      .catch(() => { if (!cancelled) setBranches([]); });
    return () => { cancelled = true; };
  }, []);

  const set = (k: keyof CouponForm) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const setType = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as DiscountType;
    // Both flat and percent honour value, min, and cap. No type-specific
    // resets needed; just clear the inline value error.
    setForm((f) => ({ ...f, type: next }));
    setValueError(null);
  };

  const toggleFirstOrder = (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, firstOrderOnly: e.target.checked }));

  const toggleBranch = (id: string) =>
    setForm((f) => ({
      ...f,
      branchIds: f.branchIds.includes(id)
        ? f.branchIds.filter((b) => b !== id)
        : [...f.branchIds, id],
    }));

  const startEdit = (c: Coupon) => {
    setEditingId(c.id);
    setEditingCoupon(c);
    setForm({
      code: c.code || '',
      // Legacy rows (e.g. free_delivery) fall back to 'flat' so the form
      // doesn't end up in an invalid type state. Type/value/code are
      // immutable in edit mode anyway.
      type: c.discount_type === 'percent' ? 'percent' : 'flat',
      value: String(c.discount_value ?? ''),
      min: c.min_order_rs != null ? String(c.min_order_rs) : '',
      maxdis: c.max_discount_rs != null ? String(c.max_discount_rs) : '',
      limit: c.usage_limit != null ? String(c.usage_limit) : '',
      perUserLimit: c.per_user_limit != null ? String(c.per_user_limit) : '',
      firstOrderOnly: !!c.first_order_only,
      branchIds: Array.isArray(c.branch_ids) ? c.branch_ids : [],
      from: toDateInput(c.valid_from),
      until: toDateInput(c.valid_until),
      desc: c.description || '',
    });
    setValueError(null);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingCoupon(null);
    setForm(EMPTY_FORM);
    setValueError(null);
  };

  const handleSubmit = async () => {
    setValueError(null);
    const code = (form.code || '').trim().toUpperCase();
    const value = parseFloat(form.value);

    if (editingId) {
      // Edit-mode validation matches create: min ≥ 0, cap > 0.
      const minNum = parseFloat(form.min);
      if (form.min === '' || Number.isNaN(minNum) || minNum < 0) {
        showToast('Min order must be ≥ 0', 'error');
        return;
      }
      const capNum = parseFloat(form.maxdis);
      if (form.maxdis === '' || Number.isNaN(capNum) || !(capNum > 0)) {
        showToast('Max discount per order must be > 0', 'error');
        return;
      }
      // PATCH body. Restaurant backend's PATCH handler currently accepts
      //   isActive, description, validUntil, usageLimit, maxDiscountRs.
      // We additionally send minOrderRs because both fields are now
      // required and editable in edit mode; the backend will silently
      // ignore unsupported keys until the allowed list is extended.
      const body: Record<string, unknown> = {
        description: form.desc.trim() || null,
        validUntil: form.until || null,
        usageLimit: form.limit === '' ? null : parseInt(form.limit, 10),
        minOrderRs: minNum,
        maxDiscountRs: capNum,
      };
      setSubmitting(true);
      try {
        await updateCoupon(editingId, body);
        showToast('Coupon updated', 'success');
        cancelEdit();
        refetch();
      } catch (err: unknown) {
        const e = err as { response?: { data?: { error?: string } }; message?: string };
        showToast(e?.response?.data?.error || e?.message || 'Update failed', 'error');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // CREATE path
    if (!code) return showToast('Coupon code is required', 'error');
    if (!value || value <= 0) {
      setValueError('Discount value must be > 0');
      return;
    }
    if (form.type === 'percent' && value > 100) {
      setValueError('Percentage cannot exceed 100');
      return;
    }
    const minNum = parseFloat(form.min);
    if (form.min === '' || Number.isNaN(minNum) || minNum < 0) {
      showToast('Min order must be ≥ 0', 'error');
      return;
    }
    const capNum = parseFloat(form.maxdis);
    if (form.maxdis === '' || Number.isNaN(capNum) || !(capNum > 0)) {
      showToast('Max discount per order must be > 0', 'error');
      return;
    }

    const body = {
      code,
      description: form.desc.trim() || null,
      discountType: form.type,
      discountValue: value,
      minOrderRs: minNum,
      maxDiscountRs: capNum,
      usageLimit: form.limit === '' ? null : parseInt(form.limit, 10),
      perUserLimit: form.perUserLimit === '' ? null : parseInt(form.perUserLimit, 10),
      firstOrderOnly: form.firstOrderOnly,
      branchIds: form.branchIds.length ? form.branchIds : null,
      validFrom: form.from || null,
      validUntil: form.until || null,
    };

    setSubmitting(true);
    try {
      await createCoupon(body);
      showToast('Coupon created!', 'success');
      setForm(EMPTY_FORM);
      refetch();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Create failed', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const isEditing = editingId !== null;
  const isPercent = form.type === 'percent';
  const coupons = data || [];

  return (
    <div>
      <div className="card mb-[1.2rem]">
        <div className="ch flex items-center justify-between">
          <h3>{isEditing ? `Edit Coupon — ${editingCoupon?.code || ''}` : 'Create Coupon'}</h3>
          {isEditing && (
            <button
              type="button"
              className="btn-g btn-xs"
              onClick={cancelEdit}
            >
              Cancel
            </button>
          )}
        </div>
        <div className="cb">
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="lbl">Coupon Code *</label>
              <input
                className="inp uppercase disabled:opacity-60 disabled:cursor-not-allowed"
                placeholder="e.g. WELCOME20"
                value={form.code}
                onChange={set('code')}
                disabled={isEditing}
                readOnly={isEditing}
              />
            </div>
            <div>
              <label className="lbl">Discount Type *</label>
              <select
                className="inp disabled:opacity-60 disabled:cursor-not-allowed"
                value={form.type}
                onChange={setType}
                disabled={isEditing}
              >
                <option value="percent">Percentage (%)</option>
                <option value="flat">Flat Amount (₹)</option>
              </select>
            </div>
            <div>
              <label className="lbl">Discount Value *</label>
              <input
                className="inp disabled:opacity-60 disabled:cursor-not-allowed"
                type="number"
                min="1"
                {...(isPercent ? { max: 100 } : {})}
                placeholder="e.g. 20"
                value={form.value}
                onChange={set('value')}
                disabled={isEditing}
              />
              {valueError && (
                <div className="mt-1 text-[0.75rem] text-red-500">{valueError}</div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="lbl">Min Order Amount (₹) *</label>
              <input
                className="inp"
                type="number"
                min="0"
                placeholder="0 = no minimum"
                value={form.min}
                onChange={set('min')}
              />
            </div>
            {/* Per-order discount cap — required for both percent and flat. */}
            <div>
              <label className="lbl">Max discount per order (₹) *</label>
              <input
                className="inp"
                type="number"
                min="1"
                value={form.maxdis}
                onChange={set('maxdis')}
              />
            </div>
            <div>
              <label className="lbl">Usage Limit</label>
              <input
                className="inp"
                type="number"
                min="1"
                placeholder="Leave blank = unlimited"
                value={form.limit}
                onChange={set('limit')}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="lbl">Uses per customer</label>
              <input
                className="inp disabled:opacity-60 disabled:cursor-not-allowed"
                type="number"
                min="1"
                placeholder="Leave blank for unlimited"
                value={form.perUserLimit}
                onChange={set('perUserLimit')}
                disabled={isEditing}
              />
            </div>
            <div className="flex items-end pb-[0.4rem]">
              <label className="flex items-center gap-3 text-[0.85rem] select-none">
                <input
                  type="checkbox"
                  className="h-4 w-4 disabled:opacity-60 disabled:cursor-not-allowed"
                  checked={form.firstOrderOnly}
                  onChange={toggleFirstOrder}
                  disabled={isEditing}
                />
                First order only
              </label>
            </div>
          </div>

          {!isEditing && branches.length > 0 && (
            <div className="mb-4">
              <label className="lbl">Limit to branches</label>
              <div className="text-[0.75rem] text-dim mb-2">
                Leave blank to apply to all your branches
              </div>
              <div className="grid grid-cols-2 gap-3">
                {branches.map((b) => (
                  <label
                    key={b.id}
                    className="flex items-center gap-3 text-[0.85rem] py-1 px-2 rounded border border-rim cursor-pointer hover:bg-rim/40"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={form.branchIds.includes(b.id)}
                      onChange={() => toggleBranch(b.id)}
                    />
                    <span className="break-words">{b.name || b.id}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="lbl">Valid From</label>
              <input
                className="inp disabled:opacity-60 disabled:cursor-not-allowed"
                type="date"
                value={form.from}
                onChange={set('from')}
                disabled={isEditing}
              />
            </div>
            <div>
              <label className="lbl">Valid Until</label>
              <input className="inp" type="date" value={form.until} onChange={set('until')} />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                className="btn w-full"
                disabled={submitting}
                onClick={handleSubmit}
              >
                {submitting
                  ? (isEditing ? 'Saving…' : 'Creating…')
                  : (isEditing ? 'Save Changes' : 'Create Coupon')}
              </button>
            </div>
          </div>

          <div>
            <label className="lbl">Description (shown to customer on WhatsApp)</label>
            <input
              className="inp"
              placeholder="e.g. 20% off on orders above ₹300"
              value={form.desc}
              onChange={set('desc')}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="ch justify-between items-center">
          <h3>Active Coupons</h3>
          <span className="text-[0.8rem] text-dim">
            Customers apply these during WhatsApp checkout
          </span>
        </div>
        <div className="cb p-0">
          {error ? (
            <div className="p-4">
              <SectionError message={error} onRetry={refetch} />
            </div>
          ) : (
            <table className="w-full border-collapse text-[0.88rem]">
              <thead>
                <tr className="bg-rim text-left">
                  <th className="py-[0.7rem] px-4">Code</th>
                  <th className="py-[0.7rem] px-4">Discount</th>
                  <th className="py-[0.7rem] px-4">Min Order</th>
                  <th className="py-[0.7rem] px-4">Used / Limit</th>
                  <th className="py-[0.7rem] px-4">Validity</th>
                  <th className="py-[0.7rem] px-4">Status</th>
                  <th className="py-[0.7rem] px-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && !data ? (
                  <tr><td colSpan={7} className="p-8 text-center text-dim">Loading…</td></tr>
                ) : coupons.length === 0 ? (
                  <tr><td colSpan={7} className="p-8 text-center text-dim">
                    No coupons yet — create one above
                  </td></tr>
                ) : (
                  coupons.map((c) => (
                    <CouponRow key={c.id} coupon={c} onChanged={refetch} onEdit={startEdit} />
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
