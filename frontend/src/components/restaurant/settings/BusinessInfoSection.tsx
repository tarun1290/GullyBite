'use client';

import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import Field from '../../Field';
import { useRestaurant } from '../../../contexts/RestaurantContext';
import { useToast } from '../../Toast';
import { updateRestaurantProfile, updateRestaurantSlug } from '../../../api/restaurant';
import type { Restaurant } from '../../../types';

interface RestaurantWithBusinessInfo extends Restaurant {
  business_name?: string;
  registered_business_name?: string;
  logo_url?: string;
  fssai_expiry?: string;
  bank_name?: string;
  bank_account_number?: string;
  bank_ifsc?: string;
  store_slug?: string;
  gst_verified?: boolean;
  fssai_verified?: boolean;
  city?: string;
  restaurant_type?: string;
  gst_number?: string;
  fssai_license?: string;
}

interface FormState {
  businessName: string;
  registeredBusinessName: string;
  ownerName: string;
  phone: string;
  email: string;
  city: string;
  restaurantType: string;
  logoUrl: string;
  gstNumber: string;
  fssaiLicense: string;
  fssaiExpiry: string;
  bankName: string;
  bankAccountNumber: string;
  bankIfsc: string;
}

interface SlugUpdateResponse {
  store_url?: string;
}

const TYPE_LABELS: Record<string, string> = { both: 'Veg & Non-Veg', veg: 'Pure Veg', non_veg: 'Non-Veg Only' };

interface ViewRowProps {
  label: string;
  value?: ReactNode;
  mono?: boolean;
  badge?: ReactNode;
}

function ViewRow({ label, value, mono, badge }: ViewRowProps) {
  const notSet = !value && value !== 0;
  return (
    <div className="flex justify-between items-center py-[0.45rem] border-b border-rim">
      <span className="text-dim text-[0.78rem] min-w-[130px]">{label}</span>
      <span
        className={`font-medium text-right text-[0.84rem] ${mono ? 'font-mono' : ''} ${
          notSet ? 'text-mute italic' : 'not-italic'
        }`}
      >
        {notSet ? 'Not set' : value}
        {badge}
      </span>
    </div>
  );
}

interface VerifBadgeProps { verified?: boolean; hasValue: boolean }

function VerifBadge({ verified, hasValue }: VerifBadgeProps) {
  if (verified) {
    return (
      <span className="ml-[0.4rem] text-[0.65rem] py-[0.1rem] px-[0.4rem] rounded-full bg-[#dcfce7] text-[#15803d] font-bold">
        ✓ Verified
      </span>
    );
  }
  if (hasValue) {
    return (
      <span className="ml-[0.4rem] text-[0.65rem] py-[0.1rem] px-[0.4rem] rounded-full bg-[#fef3c7] text-[#92400e] font-semibold">
        Pending
      </span>
    );
  }
  return null;
}

function buildForm(r: RestaurantWithBusinessInfo | null): FormState {
  return {
    businessName: r?.business_name || '',
    registeredBusinessName: r?.registered_business_name || '',
    ownerName: r?.owner_name || '',
    phone: r?.phone || '',
    email: r?.email || '',
    city: r?.city || '',
    restaurantType: r?.restaurant_type || 'both',
    logoUrl: r?.logo_url || '',
    gstNumber: r?.gst_number || '',
    fssaiLicense: r?.fssai_license || '',
    fssaiExpiry: r?.fssai_expiry ? r.fssai_expiry.split('T')[0] || '' : '',
    bankName: r?.bank_name || '',
    bankAccountNumber: r?.bank_account_number || '',
    bankIfsc: r?.bank_ifsc || '',
  };
}

function sanitizeSlug(raw: string): string {
  return (raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function BusinessInfoSection() {
  const { restaurant, loading, refetch } = useRestaurant();
  const { showToast } = useToast();
  const [editing, setEditing] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(() => buildForm(null));
  const [saving, setSaving] = useState<boolean>(false);
  const [slug, setSlug] = useState<string>('');
  const [storeUrl, setStoreUrl] = useState<string>('');
  const [savingSlug, setSavingSlug] = useState<boolean>(false);

  useEffect(() => {
    if (restaurant) {
      const r = restaurant as RestaurantWithBusinessInfo;
      setForm(buildForm(r));
      setSlug(r.store_slug || '');
      setStoreUrl(r.store_url || '');
    }
  }, [restaurant]);

  const storeBase = useMemo(() => {
    if (storeUrl) return storeUrl.replace(/\/store\/.*$/, '/store/');
    if (typeof window !== 'undefined') return `${window.location.origin}/store/`;
    return '/store/';
  }, [storeUrl]);

  const slugPlaceholder = useMemo(() => {
    const r = restaurant as RestaurantWithBusinessInfo | null;
    const source = r?.business_name || '';
    const cleaned = source
      .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim()
      .replace(/\s+/g, '-').replace(/-+/g, '-').substring(0, 40);
    return cleaned || 'restaurant-name';
  }, [restaurant]);

  const update = (k: keyof FormState) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [k]: e.target.value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateRestaurantProfile({
        businessName: form.businessName,
        registeredBusinessName: form.registeredBusinessName,
        ownerName: form.ownerName,
        phone: form.phone,
        city: form.city,
        restaurantType: form.restaurantType,
        logoUrl: form.logoUrl,
        gstNumber: form.gstNumber,
        fssaiLicense: form.fssaiLicense,
        fssaiExpiry: form.fssaiExpiry || null,
        bankName: form.bankName,
        bankAccountNumber: form.bankAccountNumber,
        bankIfsc: form.bankIfsc,
      });
      showToast('Profile saved', 'success');
      await refetch();
      setEditing(false);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSlug = async () => {
    const clean = sanitizeSlug(slug);
    if (!clean) {
      showToast('Slug cannot be empty', 'error');
      return;
    }
    setSlug(clean);
    setSavingSlug(true);
    try {
      const r = (await updateRestaurantSlug(clean)) as SlugUpdateResponse | null;
      if (r?.store_url) setStoreUrl(r.store_url);
      showToast('Store URL updated!', 'success');
      await refetch();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to update slug', 'error');
    } finally {
      setSavingSlug(false);
    }
  };

  const handleCopyUrl = () => {
    const full = storeBase + (slug || '');
    if (!full) return;
    navigator.clipboard?.writeText(full).then(
      () => showToast('Store URL copied!', 'success'),
      () => showToast('Copy failed', 'error'),
    );
  };

  const handleCopyRestaurantId = () => {
    const fullId = String(restaurant?.id || (restaurant as { _id?: string } | null)?._id || '');
    if (!fullId) return;
    navigator.clipboard?.writeText(fullId).then(
      () => showToast('Restaurant ID copied', 'success'),
      () => showToast('Copy failed', 'error'),
    );
  };

  if (loading && !restaurant) {
    return (
      <div className="card">
        <div className="ch"><h3>Business Information</h3></div>
        <div className="cb"><div className="text-dim p-2">Loading…</div></div>
      </div>
    );
  }

  const r: RestaurantWithBusinessInfo = (restaurant as RestaurantWithBusinessInfo) || {};
  const fssaiExpiryDate = r.fssai_expiry ? new Date(r.fssai_expiry) : null;
  const isExpired = fssaiExpiryDate && fssaiExpiryDate < new Date();

  return (
    <div className="card mb-[1.2rem]">
      <div className="ch justify-between">
        <h3>Business Information</h3>
        {!editing && (
          <button type="button" className="btn-g btn-sm" onClick={() => setEditing(true)}>
            ✎ Edit
          </button>
        )}
      </div>
      <div className="cb">
        {!editing ? (
          <div>
            {(() => {
              const fullId = String(r.id || (r as { _id?: string })._id || '');
              if (!fullId) return null;
              const shortId = fullId.slice(0, 8);
              return (
                <ViewRow
                  label="Restaurant ID"
                  mono
                  value={(
                    <span className="inline-flex items-center gap-[0.4rem]">
                      <span
                        title={fullId}
                        className="py-[0.15rem] px-2 bg-ink2 rounded-[5px] text-[0.78rem]"
                      >
                        {shortId}
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyRestaurantId}
                        title="Copy full ID for support"
                        className="bg-wa text-white border-0 rounded-[4px] py-[0.15rem] px-[0.45rem] text-[0.66rem] font-semibold cursor-pointer"
                      >
                        Copy
                      </button>
                    </span>
                  )}
                />
              );
            })()}
            <ViewRow label="Brand Name" value={r.business_name} />
            <ViewRow label="Legal Name" value={r.registered_business_name} />
            <ViewRow label="Owner" value={r.owner_name} />
            <ViewRow label="Phone" value={r.phone} />
            <ViewRow label="Email" value={r.email} />
            <ViewRow label="City" value={r.city} />
            <ViewRow label="Type" value={r.restaurant_type ? (TYPE_LABELS[r.restaurant_type] || r.restaurant_type) : ''} />
            {r.logo_url && (
              <ViewRow
                label="Logo"
                value={<img src={r.logo_url} alt="" className="h-7 rounded-[4px]" />}
              />
            )}

            <p className="text-[0.82rem] font-semibold text-dim mt-[0.8rem] mb-[0.4rem]">
              Legal &amp; Compliance
            </p>
            <ViewRow
              label="GST Number"
              value={r.gst_number}
              mono
              badge={<VerifBadge verified={r.gst_verified} hasValue={!!r.gst_number} />}
            />
            <ViewRow
              label="FSSAI License"
              value={r.fssai_license}
              mono
              badge={<VerifBadge verified={r.fssai_verified} hasValue={!!r.fssai_license} />}
            />
            {fssaiExpiryDate && (
              <ViewRow
                label="FSSAI Expiry"
                value={
                  <span className={isExpired ? 'text-red' : ''}>
                    {fssaiExpiryDate.toLocaleDateString('en-IN', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })}
                    {isExpired ? ' (EXPIRED)' : ''}
                  </span>
                }
              />
            )}

            <p className="text-[0.82rem] font-semibold text-dim mt-[0.8rem] mb-[0.4rem]">
              Store URL
            </p>
            {r.store_url ? (
              <div className="flex items-center gap-2 py-[0.4rem] px-[0.6rem] bg-ink2 rounded-md mb-[0.3rem]">
                <a
                  href={r.store_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 font-mono text-[0.8rem] text-acc break-all"
                >
                  {r.store_url}
                </a>
                <button
                  type="button"
                  onClick={handleCopyUrl}
                  className="bg-wa text-white border-0 rounded-[5px] py-1 px-[0.6rem] text-[0.72rem] font-semibold cursor-pointer"
                >
                  Copy
                </button>
              </div>
            ) : <ViewRow label="Store URL" value={null} />}

            <p className="text-[0.82rem] font-semibold text-dim mt-[0.8rem] mb-[0.4rem]">
              Bank Account
            </p>
            {r.bank_name || r.bank_account_number ? (
              <>
                <ViewRow label="Bank" value={r.bank_name} />
                <ViewRow
                  label="Account"
                  value={r.bank_account_number ? `••••••${r.bank_account_number.slice(-4)}` : null}
                />
                <ViewRow label="IFSC" value={r.bank_ifsc} mono />
              </>
            ) : (
              <div className="text-[0.8rem] text-mute italic py-[0.3rem]">
                No bank details — add in Edit mode
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="fgrid">
              <Field label="Brand Name">
                <input value={form.businessName} onChange={update('businessName')} placeholder="Burger Palace" />
              </Field>
              <Field
                label="Registered Business Name"
                hint="Optional — your legal entity name as registered with GST or MCA"
              >
                <input value={form.registeredBusinessName} onChange={update('registeredBusinessName')} placeholder="As per GST / legal registration" />
              </Field>
              <Field label="Owner / Contact Name">
                <input value={form.ownerName} onChange={update('ownerName')} placeholder="Rajesh Kumar" />
              </Field>
              <Field label="Phone">
                <input value={form.phone} onChange={update('phone')} placeholder="+91 98765 43210" />
              </Field>
              <Field label="Email">
                <input value={form.email} readOnly disabled className="bg-ink2 text-dim" />
              </Field>
              <Field label="City">
                <input value={form.city} onChange={update('city')} placeholder="Mumbai" />
              </Field>
              <Field label="Restaurant Type">
                <select value={form.restaurantType} onChange={update('restaurantType')}>
                  <option value="both">Veg &amp; Non-Veg</option>
                  <option value="veg">Pure Veg</option>
                  <option value="non_veg">Non-Veg Only</option>
                </select>
              </Field>
              <Field label="Logo URL" className="span2">
                <input value={form.logoUrl} onChange={update('logoUrl')} placeholder="https://example.com/logo.png" />
              </Field>
            </div>

            <hr className="dv" />
            <p className="text-[0.84rem] font-semibold text-dim mb-[0.85rem]">
              Legal &amp; Compliance
            </p>
            <div className="fgrid">
              <Field label={<>GST Number <VerifBadge verified={r.gst_verified} hasValue={!!form.gstNumber} /></>}>
                <input
                  value={form.gstNumber}
                  onChange={(e) => setForm((p) => ({ ...p, gstNumber: e.target.value.toUpperCase() }))}
                  placeholder="22AAAAA0000A1Z5"
                  className="uppercase"
                />
              </Field>
              <Field label={<>FSSAI License <VerifBadge verified={r.fssai_verified} hasValue={!!form.fssaiLicense} /></>}>
                <input value={form.fssaiLicense} onChange={update('fssaiLicense')} placeholder="12345678901234" />
              </Field>
              <Field label="FSSAI Expiry Date">
                <input type="date" value={form.fssaiExpiry} onChange={update('fssaiExpiry')} />
              </Field>
            </div>
            <div className="bg-[#fefce8] border border-[#fde68a] rounded-lg py-[0.6rem] px-[0.9rem] mt-[0.7rem] text-[0.75rem] text-[#92400e]">
              GST and FSSAI details are manually verified by the GullyBite team.
            </div>

            <hr className="dv" />
            <p className="text-[0.84rem] font-semibold text-dim mb-2">
              Store URL
            </p>
            <div className="flex items-center gap-2 mb-[0.3rem]">
              <span className="text-[0.8rem] text-dim font-mono whitespace-nowrap">
                {storeBase}
              </span>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="flex-1 bg-ink4 border border-rim rounded-[7px] py-[0.38rem] px-[0.7rem] text-[0.8rem] text-tx outline-hidden font-mono"
                placeholder={slugPlaceholder}
              />
              <button
                type="button"
                className="btn-g btn-sm whitespace-nowrap"
                onClick={handleSaveSlug}
                disabled={savingSlug}
              >
                {savingSlug ? 'Saving…' : 'Save Slug'}
              </button>
              <button
                type="button"
                onClick={handleCopyUrl}
                className="bg-wa text-white border-0 rounded-[7px] py-[0.38rem] px-[0.85rem] text-[0.77rem] font-semibold cursor-pointer whitespace-nowrap"
              >
                Copy
              </button>
            </div>
            <p className="text-[0.72rem] text-dim mb-4">
              Lowercase letters, numbers, hyphens only.
            </p>

            <hr className="dv" />
            <p className="text-[0.84rem] font-semibold text-dim mb-[0.85rem]">
              Bank Account <span className="font-normal text-[0.78rem]">(for settlements)</span>
            </p>
            <div className="fgrid">
              <Field label="Bank Name">
                <input value={form.bankName} onChange={update('bankName')} placeholder="HDFC Bank" />
              </Field>
              <Field label="Account Number">
                <input value={form.bankAccountNumber} onChange={update('bankAccountNumber')} placeholder="12345678901234" />
              </Field>
              <Field label="IFSC Code">
                <input value={form.bankIfsc} onChange={update('bankIfsc')} placeholder="HDFC0001234" />
              </Field>
            </div>

            <div className="flex gap-2 mt-[1.1rem]">
              <button
                type="button"
                className="btn-p"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              <button
                type="button"
                className="btn-g"
                onClick={() => { setForm(buildForm(restaurant as RestaurantWithBusinessInfo)); setEditing(false); }}
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
