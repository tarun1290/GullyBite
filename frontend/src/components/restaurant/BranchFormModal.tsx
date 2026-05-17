'use client';

import { useEffect, useRef, useState } from 'react';
import { useToast } from '../Toast';
import {
  createBranch,
  updateBranch,
  placesAutocomplete,
  placesDetails,
  reverseGeocode,
} from '../../api/restaurant';
import type { Branch } from '../../types';
import BranchStaffLinkPanel from './BranchStaffLinkPanel';

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
  const [form, setForm] = useState<FormState>(emptyForm());
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState<boolean>(false);
  const [searching, setSearching] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [mapLoading, setMapLoading] = useState<boolean>(false);
  const [geocoding, setGeocoding] = useState<boolean>(false);
  const [, setMapCenter] = useState<{ lat: number; lng: number }>({ lat: 17.385, lng: 78.4867 });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const mapMarkerRef = useRef<google.maps.Marker | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

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

  // Esc cancels — never submits. Mirrors CostConfirmCard's keydown
  // pattern (window listener, e.key === 'Escape', cleanup on unmount).
  // This modal collects critical onboarding branch data: the only
  // keyboard exit is a dismissal via onClose, never handleSave.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus management: park focus on the first form field (Branch Name)
  // rather than the close button, so keyboard users land in the form.
  // Capture the pre-mount focus owner and restore it on close so the
  // operator returns to where they were after the modal dismisses.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    prevFocusRef.current = active instanceof HTMLElement ? active : null;
    firstFieldRef.current?.focus();
    return () => {
      const prev = prevFocusRef.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open]);

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
        await createBranch({ ...body });
        // Onboarding is admin-gated: the branch is created in
        // 'pending_approval' (no payment step) and stays hidden until
        // an admin approves it. Refetch + close so the parent's branch
        // list shows the new pending row.
        showToast(`✅ "${name}" created — awaiting admin approval.`, 'success');
        if (onSaved) onSaved();
        else if (onCreated) onCreated();
        onClose();
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
      className="fixed inset-0 bg-black/50 z-100 flex items-start justify-center py-8 px-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card max-w-[560px] w-full bg-surface">
        <div className="ch justify-between">
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
                <div className="flex gap-1.5 items-stretch">
                  <input
                    value={existingBranch.id}
                    readOnly
                    aria-readonly="true"
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 font-mono text-sm bg-ink2 text-dim cursor-text"
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
                    className="btn-g btn-sm shrink-0"
                    aria-label="Copy branch ID to clipboard"
                    title="Copy branch ID"
                  >
                    📋 Copy
                  </button>
                </div>
              </div>
            )}
            <div className="fg">
              <label>Branch Name ★</label>
              <input
                ref={firstFieldRef}
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

            <div className="fg span2 relative">
              <label>Search Address ★</label>
              <input
                value={form.addrSearch}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Start typing address…"
                autoComplete="off"
              />
              {searching && (
                <div className="absolute right-[10px] top-[34px] text-xs text-dim">⏳</div>
              )}
              {showSuggest && suggestions.length > 0 && (
                <div
                  role="listbox"
                  aria-label="Address suggestions"
                  className="absolute top-full left-0 right-0 z-10 bg-surface border border-rim rounded-md max-h-[240px] overflow-y-auto shadow-[0_4px_12px_rgba(0,0,0,0.12)]"
                >
                  {suggestions.map((s, i) => (
                    <div
                      key={`${s.place_id}-${i}`}
                      role="option"
                      tabIndex={0}
                      aria-selected={false}
                      onClick={() => pickSuggestion(s)}
                      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          pickSuggestion(s);
                        }
                      }}
                      className="py-2.5 px-3.5 cursor-pointer text-sm border-b border-bdr leading-[1.4] hover:bg-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
                    >
                      <div className="font-semibold">{s.mainText}</div>
                      <div className="text-xs text-dim mt-0.5">
                        {s.secondaryText}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {form.addrConfirm && (
                <div className="text-xs text-wa mt-1">
                  ✅ {form.addrConfirm}
                </div>
              )}
              <div className="mt-2">
                <div className="text-xs text-dim mb-1">
                  Drag the pin to fine-tune your branch location
                </div>
                {mapLoading ? (
                  <div className="w-full h-[280px] rounded-lg border border-rim bg-ink2 flex items-center justify-center text-sm text-dim">
                    Loading map…
                  </div>
                ) : (
                  <div
                    id="gb-branch-map"
                    className="w-full h-[280px] rounded-lg overflow-hidden border border-rim"
                  />
                )}
                {geocoding && (
                  <div className="text-xs text-dim mt-1">
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
              <div className="text-xs text-dim py-1.5">
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
                className="uppercase"
              />
            </div>
          </div>

          {/* Staff login link — edit mode only (new branches don't have an
              id to fetch a link for yet). One additive panel below the
              form fields, before the action buttons. */}
          {isEdit && existingBranch && (
            <BranchStaffLinkPanel branchId={existingBranch.id} />
          )}

          {!isEdit && (
            <div
              role="status"
              className="mt-2.5 py-2 px-3 bg-amber-100 border border-yellow-200 rounded-lg text-sm text-amber-900"
            >
              New branches are reviewed by an admin before they go live.
            </div>
          )}
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              className="btn-p"
              onClick={handleSave}
              disabled={saving}
            >
              {saving
                ? (isEdit ? 'Saving…' : 'Creating…')
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
