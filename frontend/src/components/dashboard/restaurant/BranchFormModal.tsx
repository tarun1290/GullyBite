'use client';

import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../Toast';
import { useRestaurant } from '../../../contexts/RestaurantContext';
import {
  createBranch,
  updateBranch,
  activateBranchSubscription,
  placesAutocomplete,
  placesDetails,
  reverseGeocode,
  type BranchRazorpayOrder,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';
import BranchStaffLinkPanel from './BranchStaffLinkPanel';

// ── Razorpay Checkout integration ─────────────────────────────────
// Mirrors the loader pattern used by WalletSection — script is loaded
// on demand and reused if already present on the page. Distinct copy
// rather than a shared util to keep this PR scoped; both copies are
// safe to call concurrently because of the duplicate-script guard.
const RAZORPAY_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayHandlerArgs {
  razorpay_payment_id?: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
}
interface RazorpayOpts {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string };
  handler: (response: RazorpayHandlerArgs) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
}
interface RazorpayInstance { open: () => void }
type RazorpayCtor = new (opts: RazorpayOpts) => RazorpayInstance;
type RazorpayWindow = Window & { Razorpay?: RazorpayCtor };

function loadRazorpayScript(): Promise<RazorpayCtor> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('No window'));
    const w = window as RazorpayWindow;
    if (w.Razorpay) return resolve(w.Razorpay);
    const existing = document.querySelector(`script[src="${RAZORPAY_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => {
        const ctor = (window as RazorpayWindow).Razorpay;
        if (ctor) resolve(ctor); else reject(new Error('Razorpay script loaded but constructor missing'));
      });
      existing.addEventListener('error', () => reject(new Error('Razorpay script failed to load')));
      return undefined;
    }
    const s = document.createElement('script');
    s.src = RAZORPAY_SRC;
    s.async = true;
    s.onload = () => {
      const ctor = (window as RazorpayWindow).Razorpay;
      if (ctor) resolve(ctor); else reject(new Error('Razorpay script loaded but constructor missing'));
    };
    s.onerror = () => reject(new Error('Razorpay script failed to load'));
    document.head.appendChild(s);
    return undefined;
  });
}

type GoogleWindow = Window & { google?: typeof google };

function loadGoogleMapsScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  const w = window as GoogleWindow;
  if (w.google?.maps) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '';
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=maps,marker`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Google Maps script failed to load'));
    document.head.appendChild(s);
  });
}

interface MapInitResult {
  map: google.maps.Map;
  marker: google.maps.Marker;
}

function initMap(
  containerId: string,
  center: { lat: number; lng: number },
  onPinDrop: (pos: { lat: number; lng: number }) => void,
): MapInitResult | null {
  const el = document.getElementById(containerId);
  if (!el) return null;
  const w = window as GoogleWindow;
  if (!w.google?.maps) return null;
  const map = new w.google.maps.Map(el, { center, zoom: 15 });
  const marker = new w.google.maps.Marker({ position: center, map, draggable: true });
  marker.addListener('dragend', () => {
    const pos = marker.getPosition();
    if (pos) onPinDrop({ lat: pos.lat(), lng: pos.lng() });
  });
  return { map, marker };
}

const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

interface FormState {
  name: string;
  city: string;
  addrSearch: string;
  addrConfirm: string;
  fullAddress: string;
  lat: string;
  lng: string;
  area: string;
  pincode: string;
  state: string;
  placeId: string;
  openingTime: string;
  closingTime: string;
  managerPhone: string;
  fssai: string;
  gst: string;
}

interface PlaceSuggestion {
  place_id: string;
  mainText?: string;
  secondaryText?: string;
}

interface PlaceDetails {
  full_address?: string;
  city?: string;
  area?: string;
  pincode?: string;
  state?: string;
  place_id?: string;
  lat?: number;
  lng?: number;
}

interface AutocompleteResponse { suggestions?: PlaceSuggestion[] }

function emptyForm(): FormState {
  return {
    name: '',
    city: '',
    addrSearch: '',
    addrConfirm: '',
    fullAddress: '',
    lat: '',
    lng: '',
    area: '',
    pincode: '',
    state: '',
    placeId: '',
    openingTime: '10:00',
    closingTime: '22:00',
    managerPhone: '',
    fssai: '',
    gst: '',
  };
}

interface BranchExt extends Branch {
  fssai_number?: string;
  manager_phone?: string;
}

function formFromBranch(b: BranchExt | null): FormState {
  if (!b) return emptyForm();
  return {
    name:             b.name || '',
    city:             b.city || '',
    addrSearch:       b.address || '',
    addrConfirm:      b.address || '',
    fullAddress:      b.address || '',
    lat:              b.latitude  != null ? String(b.latitude)  : '',
    lng:              b.longitude != null ? String(b.longitude) : '',
    area:             b.area || '',
    pincode:          b.pincode || '',
    state:            b.state || '',
    placeId:          b.place_id || '',
    openingTime:      (b.opening_time || '10:00').slice(0, 5),
    closingTime:      (b.closing_time || '22:00').slice(0, 5),
    managerPhone:     b.manager_phone || '',
    fssai:            b.fssai_number || '',
    gst:              b.gst_number || '',
  };
}

interface BranchFormModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  onCreated?: () => void;
  mode?: 'create' | 'edit';
  existingBranch?: BranchExt | null;
}

export default function BranchFormModal({
  open,
  onClose,
  onSaved,
  onCreated,
  mode = 'create',
  existingBranch = null,
}: BranchFormModalProps) {
  const isEdit = mode === 'edit' && !!existingBranch;
  const { showToast } = useToast();
  const { restaurant } = useRestaurant();
  const [form, setForm] = useState<FormState>(emptyForm());
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState<boolean>(false);
  const [searching, setSearching] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  // Tracks the in-flight subscription payment for a just-created branch.
  // Set the moment Razorpay Checkout opens; cleared on activate success
  // or when the modal is dismissed. While set, the "+ Add Branch"
  // submit is disabled — re-submitting would create a duplicate branch
  // since the first one is already inserted (just unpaid).
  const [pendingPaymentBranchId, setPendingPaymentBranchId] = useState<string | null>(null);
  const [mapLoading, setMapLoading] = useState<boolean>(false);
  const [geocoding, setGeocoding] = useState<boolean>(false);
  const [, setMapCenter] = useState<{ lat: number; lng: number }>({ lat: 17.385, lng: 78.4867 });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const mapMarkerRef = useRef<google.maps.Marker | null>(null);

  const handlePinDrop = async ({ lat, lng }: { lat: number; lng: number }) => {
    setGeocoding(true);
    setMapCenter({ lat, lng });
    try {
      const d = (await reverseGeocode(lat, lng)) as PlaceDetails;
      setForm((f) => ({
        ...f,
        lat: String(lat),
        lng: String(lng),
        addrSearch: d.full_address || f.addrSearch,
        fullAddress: d.full_address || f.fullAddress,
        addrConfirm: [d.area, d.city, d.pincode].filter(Boolean).join(', '),
        city: d.city || f.city,
        area: d.area || '',
        pincode: d.pincode || '',
        state: d.state || '',
        placeId: d.place_id || '',
      }));
    } catch {
      setForm((f) => ({ ...f, lat: String(lat), lng: String(lng) }));
      showToast('Could not get address for that pin location', 'error');
    } finally {
      setGeocoding(false);
    }
  };

  useEffect(() => {
    if (open) {
      setForm(isEdit ? formFromBranch(existingBranch) : emptyForm());
      setSuggestions([]);
      setShowSuggest(false);
      const lat = isEdit ? Number(existingBranch?.latitude)  : NaN;
      const lng = isEdit ? Number(existingBranch?.longitude) : NaN;
      const center = (Number.isFinite(lat) && Number.isFinite(lng))
        ? { lat, lng }
        : { lat: 17.385, lng: 78.4867 };
      setMapCenter(center);
      setMapLoading(true);
      loadGoogleMapsScript()
        .then(() => {
          setMapLoading(false);
          setTimeout(() => {
            const refs = initMap('gb-branch-map', center, handlePinDrop);
            if (refs) {
              mapInstanceRef.current = refs.map;
              mapMarkerRef.current = refs.marker;
            }
          }, 50);
        })
        .catch(() => {
          setMapLoading(false);
          showToast('Could not load map', 'error');
        });
    } else {
      mapInstanceRef.current = null;
      mapMarkerRef.current = null;
    }
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, existingBranch]);

  const setField = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleSearchChange = (value: string) => {
    setField('addrSearch', value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!value || value.length < 2) {
      setSuggestions([]);
      setShowSuggest(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = (await placesAutocomplete(value)) as AutocompleteResponse | null;
        setSuggestions(res?.suggestions || []);
        setShowSuggest(true);
      } catch {
        setSuggestions([]);
        setShowSuggest(false);
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  const pickSuggestion = async (s: PlaceSuggestion) => {
    setShowSuggest(false);
    setSearching(true);
    try {
      const d = (await placesDetails(s.place_id)) as PlaceDetails;
      const parts = [d.area, d.city, d.pincode].filter(Boolean);
      setForm((f) => ({
        ...f,
        addrSearch: d.full_address || '',
        fullAddress: d.full_address || '',
        city: d.city || f.city,
        lat: d.lat != null ? String(d.lat) : '',
        lng: d.lng != null ? String(d.lng) : '',
        area: d.area || '',
        pincode: d.pincode || '',
        state: d.state || '',
        placeId: d.place_id || '',
        addrConfirm: parts.join(', '),
      }));
      const w = window as GoogleWindow;
      if (d.lat != null && d.lng != null && w.google?.maps && mapMarkerRef.current && mapInstanceRef.current) {
        const next = { lat: d.lat, lng: d.lng };
        mapMarkerRef.current.setPosition(next);
        mapInstanceRef.current.panTo(next);
        setMapCenter(next);
      }
    } catch (err: unknown) {
      const e = err as { message?: string };
      showToast('Could not fetch address details: ' + (e.message || ''), 'error');
    } finally {
      setSearching(false);
    }
  };

  // Open Razorpay Checkout for a freshly-created branch's first-month
  // subscription order. On payment success, posts the signed tuple to
  // /branches/:id/activate-subscription, then refetches via onSaved/
  // onCreated so the parent's branch list shows the new 'active' status.
  // On dismiss, leaves the branch row in pending_payment and keeps the
  // form open per spec (user closes the modal manually).
  const openSubscriptionCheckout = async (branchId: string, order: BranchRazorpayOrder) => {
    setPendingPaymentBranchId(branchId);
    let Razorpay: RazorpayCtor;
    try {
      Razorpay = await loadRazorpayScript();
    } catch {
      showToast('Could not load payment library — please retry', 'error');
      setPendingPaymentBranchId(null);
      return;
    }
    const key = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '';
    if (!key) {
      showToast('Payment is not configured (missing key)', 'error');
      setPendingPaymentBranchId(null);
      return;
    }

    const opts: RazorpayOpts = {
      key,
      amount: order.amount,
      currency: order.currency || 'INR',
      order_id: order.id,
      name: 'GullyBite',
      description: 'Branch Subscription - First Month',
      prefill: {
        name: restaurant?.owner_name || restaurant?.brand_name || undefined,
        email: restaurant?.owner_email || restaurant?.email || undefined,
      },
      handler: async (resp) => {
        if (!resp?.razorpay_order_id || !resp?.razorpay_payment_id || !resp?.razorpay_signature) {
          showToast('Payment response was incomplete — please retry', 'error');
          setPendingPaymentBranchId(null);
          return;
        }
        try {
          await activateBranchSubscription(branchId, {
            razorpay_order_id: resp.razorpay_order_id,
            razorpay_payment_id: resp.razorpay_payment_id,
            razorpay_signature: resp.razorpay_signature,
          });
          showToast('Branch activated successfully', 'success');
          setPendingPaymentBranchId(null);
          // Refetch via parent — the server now reports the branch with
          // subscription_status: 'active', so a refetch is the simplest
          // way to "update local state" without reaching across files.
          if (onSaved) onSaved();
          else if (onCreated) onCreated();
          onClose();
        } catch (err: unknown) {
          const e = err as { response?: { data?: { error?: string } }; message?: string };
          const msg = e?.response?.data?.error === 'invalid_signature'
            ? 'Payment verification failed (invalid signature) — please contact support.'
            : (e?.response?.data?.error || e?.message || 'Could not activate subscription');
          showToast(msg, 'error');
          setPendingPaymentBranchId(null);
        }
      },
      modal: {
        ondismiss: () => {
          showToast('Payment pending — branch will be visible once payment is completed.', 'warning');
          setPendingPaymentBranchId(null);
        },
      },
      theme: { color: '#25D366' },
    };
    const rzp = new Razorpay(opts);
    rzp.open();
  };

  const handleSave = async () => {
    const name = form.name.trim();
    const lat = parseFloat(form.lat);
    const lng = parseFloat(form.lng);
    const fssai = form.fssai.trim();
    const gst = form.gst.trim().toUpperCase();
    if (!name || isNaN(lat) || isNaN(lng)) {
      showToast('Branch name and address selection are required', 'error');
      return;
    }
    const fssaiRequired = !isEdit || !!existingBranch?.fssai_number;
    if (fssaiRequired) {
      if (!/^\d{14}$/.test(fssai)) {
        showToast('FSSAI license must be exactly 14 digits', 'error');
        return;
      }
    } else if (fssai && !/^\d{14}$/.test(fssai)) {
      showToast('FSSAI license must be exactly 14 digits if provided', 'error');
      return;
    }
    if (gst && !GST_RE.test(gst)) {
      showToast('GST number is not a valid 15-character GSTIN', 'error');
      return;
    }

    setSaving(true);
    const body = {
      name,
      city: form.city || '',
      address: form.fullAddress,
      latitude: lat,
      longitude: lng,
      pincode: form.pincode || '',
      area: form.area || '',
      state: form.state || '',
      place_id: form.placeId || '',
      openingTime: form.openingTime,
      closingTime: form.closingTime,
      managerPhone: form.managerPhone,
      fssai_number: fssai || null,
      gst_number: gst || undefined,
    };
    try {
      if (isEdit && existingBranch) {
        await updateBranch(existingBranch.id, { ...body });
        showToast(`✅ "${name}" updated`, 'success');
        if (onSaved) onSaved();
        else if (onCreated) onCreated();
        onClose();
      } else {
        const created = await createBranch({ ...body });
        showToast(`✅ "${name}" added! Creating WhatsApp catalog…`, 'success');
        // First-month subscription paywall: backend returns razorpay_order
        // alongside the branch. Open Checkout immediately. The branch row
        // exists in pending_payment until payment lands; if checkout is
        // dismissed, we keep the form open so the user knows what's
        // outstanding (per spec). On success we close + refetch.
        if (created.razorpay_order && created.id) {
          await openSubscriptionCheckout(created.id, created.razorpay_order);
        } else {
          // Branch created without a subscription order (e.g. legacy
          // backend or admin-bypass path) — fall back to the prior
          // behaviour: refetch + close.
          if (onSaved) onSaved();
          else if (onCreated) onCreated();
          onClose();
        }
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const code = e?.response?.data?.error;
      if (code === 'SERVICE_UNAVAILABLE') {
        showToast("We don't currently deliver to this area. Please check the pincode and try again.", 'error');
      } else {
        showToast(code || e?.message || (isEdit ? 'Failed to update branch' : 'Failed to create branch'), 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 100,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '2rem 1rem', overflowY: 'auto',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={{ maxWidth: 560, width: '100%', background: 'var(--surface,#fff)' }}>
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>{isEdit ? 'Edit Branch' : '+ Add Branch'}</h3>
          <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={saving}>✕</button>
        </div>
        <div className="cb">
          <div className="fgrid">
            {/* Edit-mode only: surface the immutable branch _id with a
                copy-to-clipboard affordance. Useful for support tickets,
                catalog debugging, and the new paywall flows that key off
                the id. Span-2 so the id+button live on one row without
                squeezing the next "Branch Name / City" pair. */}
            {isEdit && existingBranch?.id && (
              <div className="fg span2">
                <label>Branch ID</label>
                <div style={{ display: 'flex', gap: '.4rem', alignItems: 'stretch' }}>
                  <input
                    value={existingBranch.id}
                    readOnly
                    aria-readonly="true"
                    onFocus={(e) => e.currentTarget.select()}
                    style={{
                      flex: 1,
                      fontFamily: 'monospace',
                      fontSize: '.78rem',
                      background: 'var(--ink2,#f4f4f5)',
                      color: 'var(--dim,#6b7280)',
                      cursor: 'text',
                    }}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const id = existingBranch.id;
                      // navigator.clipboard requires a secure context
                      // (https / localhost). Falls back to an error
                      // toast if it's missing or rejected — no
                      // execCommand legacy path since the dashboard
                      // runs in HTTPS in every deployed env.
                      try {
                        if (!navigator.clipboard?.writeText) {
                          throw new Error('clipboard API unavailable');
                        }
                        await navigator.clipboard.writeText(id);
                        showToast('Branch ID copied', 'success');
                      } catch {
                        showToast('Could not copy — select the field and copy manually', 'error');
                      }
                    }}
                    className="btn-g btn-sm"
                    aria-label="Copy branch ID to clipboard"
                    title="Copy branch ID"
                    style={{ flexShrink: 0 }}
                  >
                    📋 Copy
                  </button>
                </div>
              </div>
            )}
            <div className="fg">
              <label>Branch Name ★</label>
              <input
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="Koramangala Outlet"
              />
            </div>
            <div className="fg">
              <label>City</label>
              <input
                value={form.city}
                onChange={(e) => setField('city', e.target.value)}
                placeholder="Bangalore"
              />
            </div>

            <div className="fg span2" style={{ position: 'relative' }}>
              <label>Search Address ★</label>
              <input
                value={form.addrSearch}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Start typing address…"
                autoComplete="off"
              />
              {searching && (
                <div style={{ position: 'absolute', right: 10, top: 34, fontSize: '.7rem', color: 'var(--dim)' }}>⏳</div>
              )}
              {showSuggest && suggestions.length > 0 && (
                <div
                  style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                    background: 'var(--surface,#fff)', border: '1px solid var(--rim)', borderRadius: 6,
                    maxHeight: 240, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,.12)',
                  }}
                >
                  {suggestions.map((s, i) => (
                    <div
                      key={`${s.place_id}-${i}`}
                      onClick={() => pickSuggestion(s)}
                      style={{
                        padding: '.65rem .9rem', cursor: 'pointer',
                        fontSize: '.83rem', borderBottom: '1px solid var(--bdr,#e5e7eb)', lineHeight: 1.4,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ink2,#f4f4f5)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <div style={{ fontWeight: 600 }}>{s.mainText}</div>
                      <div style={{ fontSize: '.77rem', color: 'var(--dim)', marginTop: '.15rem' }}>
                        {s.secondaryText}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {form.addrConfirm && (
                <div style={{ fontSize: '.74rem', color: 'var(--wa,#16a34a)', marginTop: '.3rem' }}>
                  ✅ {form.addrConfirm}
                </div>
              )}
              <div style={{ marginTop: '.55rem' }}>
                <div style={{ fontSize: '.74rem', color: 'var(--dim)', marginBottom: '.25rem' }}>
                  Drag the pin to fine-tune your branch location
                </div>
                {mapLoading ? (
                  <div style={{
                    width: '100%', height: 280, borderRadius: 8,
                    border: '1px solid var(--rim)', background: 'var(--ink2,#f4f4f5)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '.82rem', color: 'var(--dim)',
                  }}
                  >
                    Loading map…
                  </div>
                ) : (
                  <div
                    id="gb-branch-map"
                    style={{ width: '100%', height: 280, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--rim)' }}
                  />
                )}
                {geocoding && (
                  <div style={{ fontSize: '.74rem', color: 'var(--dim)', marginTop: '.3rem' }}>
                    📍 Getting address…
                  </div>
                )}
              </div>
            </div>

            <div className="fg">
              <label>Latitude</label>
              <input value={form.lat} readOnly placeholder="Auto-filled" />
            </div>
            <div className="fg">
              <label>Longitude</label>
              <input value={form.lng} readOnly placeholder="Auto-filled" />
            </div>

            <div className="fg">
              <label>Delivery Radius</label>
              <div style={{ fontSize: '.74rem', color: 'var(--dim)', padding: '.4rem 0' }}>
                Delivery radius is managed platform-wide by GullyBite.
              </div>
            </div>
            <div className="fg">
              <label>Manager Phone</label>
              <input
                value={form.managerPhone}
                onChange={(e) => setField('managerPhone', e.target.value)}
                placeholder="+91 98765 43210"
              />
            </div>

            <div className="fg">
              <label>Opening Time</label>
              <input
                type="time"
                value={form.openingTime}
                onChange={(e) => setField('openingTime', e.target.value)}
              />
            </div>
            <div className="fg">
              <label>Closing Time</label>
              <input
                type="time"
                value={form.closingTime}
                onChange={(e) => setField('closingTime', e.target.value)}
              />
            </div>

            <div className="fg">
              <label>FSSAI License ★</label>
              <input
                value={form.fssai}
                onChange={(e) => setField('fssai', e.target.value)}
                placeholder="14 digits"
                maxLength={14}
              />
            </div>
            <div className="fg">
              <label>GST Number</label>
              <input
                value={form.gst}
                onChange={(e) => setField('gst', e.target.value.toUpperCase())}
                placeholder="15-char GSTIN (optional)"
                maxLength={15}
                style={{ textTransform: 'uppercase' }}
              />
            </div>
          </div>

          {/* Staff login link — edit mode only (new branches don't have an
              id to fetch a link for yet). One additive panel below the
              form fields, before the action buttons. */}
          {isEdit && existingBranch && (
            <BranchStaffLinkPanel branchId={existingBranch.id} />
          )}

          {pendingPaymentBranchId && (
            <div
              role="status"
              style={{
                marginTop: '.6rem', padding: '.55rem .75rem',
                background: '#fef3c7', border: '1px solid #fde68a',
                borderRadius: 8, fontSize: '.78rem', color: '#92400e',
              }}
            >
              Payment in progress — complete the Razorpay checkout to activate this branch.
            </div>
          )}
          <div style={{ display: 'flex', gap: '.5rem', marginTop: '1rem' }}>
            <button
              type="button"
              className="btn-p"
              onClick={handleSave}
              disabled={saving || !!pendingPaymentBranchId}
              title={pendingPaymentBranchId ? 'Finish or dismiss the in-progress payment first' : undefined}
            >
              {saving
                ? (isEdit ? 'Saving…' : 'Creating…')
                : pendingPaymentBranchId
                  ? 'Awaiting Payment…'
                  : (isEdit ? 'Save Changes' : '+ Add Branch')}
            </button>
            <button type="button" className="btn-g" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
