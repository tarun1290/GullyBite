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
    <tr style={{ borderBottom: '1px solid var(--rim)' }}>
      <td style={{ padding: '.65rem 1rem', fontFamily: 'monospace', fontWeight: 700, letterSpacing: '.05em' }}>
        {coupon.code}
      </td>
      <td style={{ padding: '.65rem 1rem' }}>{discountLabel(coupon)}</td>
      <td style={{ padding: '.65rem 1rem' }}>₹{parseFloat(String(coupon.min_order_rs || 0)).toFixed(0)}</td>
      <td style={{ padding: '.65rem 1rem' }}>{usedLabel}</td>
      <td style={{ padding: '.65rem 1rem', fontSize: '.8rem' }}>
        {validFrom} → {validUntil}
      </td>
      <td style={{ padding: '.65rem 1rem' }}>
        <span style={{ fontSize: '.78rem', fontWeight: 600, color: isActive ? '#22c55e' : '#6b7280' }}>
          {isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td style={{ padding: '.65rem 1rem', display: 'flex', gap: '.5rem' }}>
        <button
          type="button"
          className="btn btn-sm"
          style={{
            padding: '.25rem .6rem',
            fontSize: '.78rem',
            background: isActive ? '#374151' : 'var(--acc)',
          }}
          disabled={toggling}
          onClick={handleToggle}
        >
          {toggling ? '…' : isActive ? 'Disable' : 'Enable'}
        </button>
        {confirmDel ? (
          <>
            <button
              type="button"
              className="btn-g btn-sm"
              style={{ padding: '.25rem .5rem', fontSize: '.76rem' }}
              disabled={deleting}
              onClick={() => setConfirmDel(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: '.25rem .6rem', fontSize: '.78rem', background: '#7f1d1d', color: '#fca5a5' }}
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? '…' : 'Confirm'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            style={{ padding: '.25rem .6rem', fontSize: '.78rem', background: '#7f1d1d', color: '#fca5a5' }}
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
      <div className="card" style={{ marginBottom: '1.2rem' }}>
        <div className="ch"><h3>Create Coupon</h3></div>
        <div className="cb">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label className="lbl">Coupon Code *</label>
              <input
                className="inp"
                placeholder="e.g. WELCOME20"
                style={{ textTransform: 'uppercase' }}
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label className="lbl">Valid From</label>
              <input className="inp" type="date" value={form.from} onChange={set('from')} />
            </div>
            <div>
              <label className="lbl">Valid Until</label>
              <input className="inp" type="date" value={form.until} onChange={set('until')} />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button
                type="button"
                className="btn"
                style={{ width: '100%' }}
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
        <div className="ch" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Active Coupons</h3>
          <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>
            Customers apply these during WhatsApp checkout
          </span>
        </div>
        <div className="cb" style={{ padding: 0 }}>
          {error ? (
            <div style={{ padding: '1rem' }}>
              <SectionError message={error} onRetry={refetch} />
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.88rem' }}>
              <thead>
                <tr style={{ background: 'var(--rim)', textAlign: 'left' }}>
                  <th style={{ padding: '.7rem 1rem' }}>Code</th>
                  <th style={{ padding: '.7rem 1rem' }}>Discount</th>
                  <th style={{ padding: '.7rem 1rem' }}>Min Order</th>
                  <th style={{ padding: '.7rem 1rem' }}>Used / Limit</th>
                  <th style={{ padding: '.7rem 1rem' }}>Validity</th>
                  <th style={{ padding: '.7rem 1rem' }}>Status</th>
                  <th style={{ padding: '.7rem 1rem' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && !data ? (
                  <tr><td colSpan={7} style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>Loading…</td></tr>
                ) : coupons.length === 0 ? (
                  <tr><td colSpan={7} style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>
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
