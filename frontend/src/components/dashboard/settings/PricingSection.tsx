'use client';

import { useEffect, useState } from 'react';
import Field from '../../Field';
import { useRestaurant } from '../../../contexts/RestaurantContext';
import { useToast } from '../../Toast';
import { updateRestaurantProfile } from '../../../api/restaurant';
import type { Restaurant } from '../../../types';

interface RestaurantWithPricing extends Restaurant {
  menu_gst_mode?: string;
  delivery_fee_customer_pct?: number | string;
  packaging_charge_rs?: number | string;
  packaging_gst_pct?: number | string;
}

interface FormState {
  menuGstMode: string;
  deliveryFeeCustomerPct: number | string;
  packagingChargeRs: number | string;
  packagingGstPct: number | string;
}

function buildForm(r: RestaurantWithPricing | null): FormState {
  return {
    menuGstMode: r?.menu_gst_mode || 'included',
    deliveryFeeCustomerPct: r?.delivery_fee_customer_pct != null ? r.delivery_fee_customer_pct : 100,
    packagingChargeRs: r?.packaging_charge_rs != null ? r.packaging_charge_rs : 0,
    packagingGstPct: r?.packaging_gst_pct != null ? r.packaging_gst_pct : 18,
  };
}

interface TileProps { label: string; value: string }

function Tile({ label, value }: TileProps) {
  return (
    <div style={{
      background: 'var(--ink2)', borderRadius: 8,
      padding: '.65rem .8rem', textAlign: 'center',
    }}
    >
      <div style={{ fontSize: '.7rem', color: 'var(--dim)', marginBottom: '.2rem' }}>{label}</div>
      <div style={{ fontSize: '.88rem', fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export default function PricingSection() {
  const { restaurant, loading, refetch } = useRestaurant();
  const { showToast } = useToast();
  const [editing, setEditing] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(() => buildForm(null));
  const [saving, setSaving] = useState<boolean>(false);

  useEffect(() => {
    if (restaurant) setForm(buildForm(restaurant as RestaurantWithPricing));
  }, [restaurant]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateRestaurantProfile({
        menuGstMode: form.menuGstMode,
        deliveryFeeCustomerPct: parseInt(String(form.deliveryFeeCustomerPct), 10) || 0,
        packagingChargeRs: parseFloat(String(form.packagingChargeRs)) || 0,
        packagingGstPct: parseFloat(String(form.packagingGstPct)),
      });
      showToast('Charge settings saved', 'success');
      await refetch();
      setEditing(false);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !restaurant) {
    return (
      <div className="card">
        <div className="ch"><h3>Pricing &amp; Charges</h3></div>
        <div className="cb"><div style={{ color: 'var(--dim)', padding: '.5rem' }}>Loading…</div></div>
      </div>
    );
  }

  const r: RestaurantWithPricing = (restaurant as RestaurantWithPricing) || {};
  const gstLabel = r.menu_gst_mode === 'included' ? 'Inclusive in prices' : 'Extra 5% at checkout';
  const delPct = r.delivery_fee_customer_pct != null ? Number(r.delivery_fee_customer_pct) : 100;
  const pkg = Number(r.packaging_charge_rs) || 0;
  const pkgGst = r.packaging_gst_pct != null ? Number(r.packaging_gst_pct) : 18;

  const hintPct = Math.min(100, Math.max(0, parseInt(String(form.deliveryFeeCustomerPct), 10) || 0));

  return (
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch" style={{ justifyContent: 'space-between' }}>
        <h3>Pricing &amp; Charges</h3>
        {!editing && (
          <button type="button" className="btn-g btn-sm" onClick={() => setEditing(true)}>
            ✎ Edit
          </button>
        )}
      </div>
      <div className="cb">
        {!editing ? (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '.8rem',
          }}
          >
            <Tile label="GST Mode" value={gstLabel} />
            <Tile
              label="Delivery Split"
              value={`${delPct}% customer / ${100 - delPct}% restaurant`}
            />
            <Tile label="Packaging" value={pkg > 0 ? `₹${pkg}/order` : 'Disabled'} />
            <Tile label="Pkg GST" value={`${pkgGst}%`} />
          </div>
        ) : (
          <div>
            <div className="fgrid">
              <Field label="Menu Prices — GST Mode" className="span2">
                <select
                  value={form.menuGstMode}
                  onChange={(e) => setForm((p) => ({ ...p, menuGstMode: e.target.value }))}
                >
                  <option value="included">GST included in menu prices</option>
                  <option value="extra">Add 5% food GST at checkout</option>
                </select>
                {form.menuGstMode === 'extra' && (
                  <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginTop: '.3rem' }}>
                    Customers will see a &quot;Food GST (5%)&quot; line item.
                  </div>
                )}
              </Field>
              <Field label="Delivery Fee — Customer Pays (%)" className="span2">
                <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={form.deliveryFeeCustomerPct}
                    onChange={(e) => setForm((p) => ({ ...p, deliveryFeeCustomerPct: e.target.value }))}
                    style={{ width: 100 }}
                  />
                  <span style={{ fontSize: '.82rem', color: 'var(--dim)' }}>% charged to customer</span>
                </div>
                <div
                  style={{
                    fontSize: '.78rem', color: 'var(--dim)', marginTop: '.45rem', lineHeight: 1.55,
                    background: 'var(--ink4)', borderRadius: 7, padding: '.45rem .7rem',
                    border: '1px solid var(--rim)',
                  }}
                >
                  Customer pays <strong>{hintPct}%</strong> of the delivery fee. Your restaurant
                  absorbs <strong>{100 - hintPct}%</strong>.
                  <br />
                  <span style={{ color: 'var(--mute,var(--dim))' }}>
                    Example: if delivery costs ₹40 and you set {hintPct}%, customer pays ₹{((40 * hintPct) / 100).toFixed(0)} and restaurant absorbs ₹{((40 * (100 - hintPct)) / 100).toFixed(0)}.
                  </span>
                </div>
              </Field>
              <Field label="Packaging Charge (₹)">
                <input
                  type="number"
                  min={0}
                  max={500}
                  step={5}
                  value={form.packagingChargeRs}
                  onChange={(e) => setForm((p) => ({ ...p, packagingChargeRs: e.target.value }))}
                  placeholder="0 = disabled"
                />
              </Field>
              <Field label="Packaging GST %">
                <select
                  value={form.packagingGstPct}
                  onChange={(e) => setForm((p) => ({ ...p, packagingGstPct: e.target.value }))}
                >
                  <option value={0}>0%</option>
                  <option value={5}>5%</option>
                  <option value={12}>12%</option>
                  <option value={18}>18%</option>
                </select>
              </Field>
            </div>

            <div style={{ display: 'flex', gap: '.5rem', marginTop: '1.1rem' }}>
              <button
                type="button"
                className="btn-p"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save Charge Settings'}
              </button>
              <button
                type="button"
                className="btn-g"
                onClick={() => { setForm(buildForm(restaurant as RestaurantWithPricing)); setEditing(false); }}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
