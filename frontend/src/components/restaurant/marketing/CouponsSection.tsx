'use client';

import { useCallback, useState, type ChangeEvent } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import { useToast } from '../../Toast';
import {
  getCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
} from '../../../api/restaurant';

interface CouponForm {
  code: string;
  type: 'percent' | 'flat';
  value: string;
  min: string;
  maxdis: string;
  limit: string;
  from: string;
  until: string;
  desc: string;
}

interface Coupon {
  id: string;
  code: string;
  description?: string;
  discount_type?: 'percent' | 'flat' | string;
  discount_value: number | string;
  min_order_rs?: number | string;
  max_discount_rs?: number | string | null;
  usage_limit?: number | null;
  usage_count?: number;
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

function discountLabel(c: Coupon): string {
  if (c.discount_type === 'percent') {
    const pct = `${parseFloat(String(c.discount_value)).toFixed(0)}%`;
    return c.max_discount_rs
      ? `${pct} (max ₹${parseFloat(String(c.max_discount_rs)).toFixed(0)})`
      : pct;
  }
  return `₹${parseFloat(String(c.discount_value)).toFixed(0)} flat`;
}

interface CouponRowProps {
  coupon: Coupon;
  onChanged?: (() => void) | undefined;
}

function CouponRow({ coupon, onChanged }: CouponRowProps) {
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
      <td className="py-[0.65rem] px-4 flex gap-2">
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
              className="btn-g btn-sm py-1 px-2 text-[0.76rem]"
              disabled={deleting}
              onClick={() => setConfirmDel(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm py-1 px-[0.6rem] text-[0.78rem] bg-[#7f1d1d] text-[#fca5a5]"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? '…' : 'Confirm'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm py-1 px-[0.6rem] text-[0.78rem] bg-[#7f1d1d] text-[#fca5a5]"
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
  const { data, loading, error, refetch } = useAnalyticsFetch<Coupon[] | null>(
    useCallback(() => getCoupons() as Promise<Coupon[] | null>, []),
    [],
  );

  const set = (k: keyof CouponForm) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleCreate = async () => {
    const code = (form.code || '').trim().toUpperCase();
    const value = parseFloat(form.value);
    if (!code) return showToast('Coupon code is required', 'error');
    if (!value || value <= 0) return showToast('Discount value must be > 0', 'error');

    const body = {
      code,
      description: form.desc.trim() || null,
      discountType: form.type,
      discountValue: value,
      minOrderRs: parseFloat(form.min) || 0,
      maxDiscountRs: parseFloat(form.maxdis) || null,
      usageLimit: parseInt(form.limit, 10) || null,
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

  const isPercent = form.type === 'percent';
  const coupons = data || [];

  return (
    <div>
      <div className="card mb-[1.2rem]">
        <div className="ch"><h3>Create Coupon</h3></div>
        <div className="cb">
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="lbl">Coupon Code *</label>
              <input
                className="inp uppercase"
                placeholder="e.g. WELCOME20"
                value={form.code}
                onChange={set('code')}
              />
            </div>
            <div>
              <label className="lbl">Discount Type *</label>
              <select className="inp" value={form.type} onChange={set('type')}>
                <option value="percent">Percentage (%)</option>
                <option value="flat">Flat Amount (₹)</option>
              </select>
            </div>
            <div>
              <label className="lbl">Discount Value *</label>
              <input
                className="inp"
                type="number"
                min="1"
                placeholder="e.g. 20"
                value={form.value}
                onChange={set('value')}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="lbl">Min Order Amount (₹)</label>
              <input
                className="inp"
                type="number"
                min="0"
                placeholder="0 = no minimum"
                value={form.min}
                onChange={set('min')}
              />
            </div>
            {isPercent && (
              <div>
                <label className="lbl">Max Discount Cap (₹)</label>
                <input
                  className="inp"
                  type="number"
                  min="0"
                  placeholder="Leave blank = no cap"
                  value={form.maxdis}
                  onChange={set('maxdis')}
                />
              </div>
            )}
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
              <label className="lbl">Valid From</label>
              <input className="inp" type="date" value={form.from} onChange={set('from')} />
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
                onClick={handleCreate}
              >
                {submitting ? 'Creating…' : 'Create Coupon'}
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
                    <CouponRow key={c.id} coupon={c} onChanged={refetch} />
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
