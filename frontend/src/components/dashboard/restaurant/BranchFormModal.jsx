import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import { createBranch, updateBranch, placesAutocomplete, placesDetails, reverseGeocode } from '../../../api/restaurant.js';

// Lazy-load the Google Maps JS SDK on first map open. Idempotent — subsequent
// calls resolve immediately if window.google.maps is already present.
function loadGoogleMapsScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.google?.maps) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=maps,marker`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Google Maps script failed to load'));
    document.head.appendChild(s);
  });
}

// Initialise a map + draggable marker inside `containerId`. Returns both
// instances so callers can panTo / setPosition when an autocomplete pick
// happens. `onPinDrop` fires after every marker dragend with the new lat/lng.
function initMap(containerId, center, onPinDrop) {
  const el = document.getElementById(containerId);
  if (!el) return null;
  const map = new window.google.maps.Map(el, { center, zoom: 15 });
  const marker = new window.google.maps.Marker({ position: center, map, draggable: true });
  marker.addListener('dragend', () => {
    const pos = marker.getPosition();
    onPinDrop({ lat: pos.lat(), lng: pos.lng() });
  });
  return { map, marker };
}

// Mirrors #menu-branch-form + doAddBranch (menu.js:253-294) plus the inline
// address autocomplete flow (menu.js:40-109). Legacy kept this as an inline
// card; we promote it to a modal so Branches can stay a focused list.
//
// Validation parity:
//   - name + valid lat/lng required
//   - fssai_number must match /^\d{14}$/
//   - gst_number (if present) must match 15-char GSTIN regex
const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function emptyForm() {
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
    deliveryRadiusKm: '5',
    openingTime: '10:00',
    closingTime: '22:00',
    managerPhone: '',
    fssai: '',
    gst: '',
  };
}

// Convert an existing branch row into the form's local shape. Used in edit
// mode to prefill all inputs. Lat/lng are persisted as numbers but the form
// stores them as strings (input.value). Hours are sliced to HH:MM in case
// the row has seconds (HH:MM:SS).
function formFromBranch(b) {
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
    deliveryRadiusKm: b.delivery_radius_km != null ? String(b.delivery_radius_km) : '5',
    openingTime:      (b.opening_time || '10:00').slice(0, 5),
    closingTime:      (b.closing_time || '22:00').slice(0, 5),
    managerPhone:     b.manager_phone || '',
    fssai:            b.fssai_number || '',
    gst:              b.gst_number || '',
  };
}

export default function BranchFormModal({ open, onClose, onSaved, onCreated, mode = 'create', existingBranch = null }) {
  // `onSaved` is the unified callback for both create + edit. `onCreated` is
  // kept as a back-compat alias for the create-only callsite.
  const isEdit = mode === 'edit' && !!existingBranch;
  const { showToast } = useToast();
  const [form, setForm] = useState(emptyForm());
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [mapCenter, setMapCenter] = useState({ lat: 17.385, lng: 78.4867 }); // Hyderabad default
  const searchTimer = useRef(null);
  const mapInstanceRef = useRef(null);
  const mapMarkerRef = useRef(null);

  useEffect(() => {
    if (open) {
      setForm(isEdit ? formFromBranch(existingBranch) : emptyForm());
      setSuggestions([]);
      setShowSuggest(false);
      // Edit mode with valid stored coords → centre on the branch. Otherwise
      // fall back to Hyderabad. The user can always re-position the marker.
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
          // Defer one tick so React commits the map container DOM first.
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

  // Pin-on-map fallback. Reverse-geocodes the dropped pin to populate the
  // same form fields pickSuggestion fills. Failure leaves lat/lng on the
  // form (the user knows the location is right) but skips address fields.
  const handlePinDrop = async ({ lat, lng }) => {
    setGeocoding(true);
    setMapCenter({ lat, lng });
    try {
      const d = await reverseGeocode(lat, lng);
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
    } catch (err) {
      // Still capture the lat/lng — user dropped the pin deliberately.
      setForm((f) => ({ ...f, lat: String(lat), lng: String(lng) }));
      showToast('Could not get address for that pin location', 'error');
    } finally {
      setGeocoding(false);
    }
  };

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSearchChange = (value) => {
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
        const res = await placesAutocomplete(value);
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

  const pickSuggestion = async (s) => {
    setShowSuggest(false);
    setSearching(true);
    try {
      const d = await placesDetails(s.place_id);
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
      // Move the always-visible map marker to the picked address so the user
      // can fine-tune the pin if Places' coordinates aren't perfect for
      // delivery routing. Defensive: skip silently if the map isn't ready.
      if (d.lat != null && d.lng != null && window.google?.maps && mapMarkerRef.current && mapInstanceRef.current) {
        const next = { lat: d.lat, lng: d.lng };
        mapMarkerRef.current.setPosition(next);
        mapInstanceRef.current.panTo(next);
        setMapCenter(next);
      }
    } catch (err) {
      showToast('Could not fetch address details: ' + err.message, 'error');
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
      return showToast('Branch name and address selection are required', 'error');
    }
    // FSSAI rules:
    //   create: required (legacy behavior).
    //   edit + branch already had FSSAI: required (don't allow blanking it).
    //   edit + branch had no FSSAI: optional (don't force the user to add one
    //     mid-rename); but if they DO type something, format must be valid.
    const fssaiRequired = !isEdit || !!existingBranch?.fssai_number;
    if (fssaiRequired) {
      if (!/^\d{14}$/.test(fssai)) {
        return showToast('FSSAI license must be exactly 14 digits', 'error');
      }
    } else if (fssai && !/^\d{14}$/.test(fssai)) {
      return showToast('FSSAI license must be exactly 14 digits if provided', 'error');
    }
    if (gst && !GST_RE.test(gst)) {
      return showToast('GST number is not a valid 15-character GSTIN', 'error');
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
      deliveryRadiusKm: parseFloat(form.deliveryRadiusKm) || 5,
      openingTime: form.openingTime,
      closingTime: form.closingTime,
      managerPhone: form.managerPhone,
      fssai_number: fssai || null,
      gst_number: gst || undefined,
    };
    try {
      if (isEdit) {
        await updateBranch(existingBranch.id, body);
        showToast(`✅ "${name}" updated`, 'success');
      } else {
        await createBranch(body);
        showToast(`✅ "${name}" added! Creating WhatsApp catalog…`, 'success');
      }
      if (onSaved) onSaved();
      else if (onCreated) onCreated();
      onClose();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || (isEdit ? 'Failed to update branch' : 'Failed to create branch'), 'error');
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
              {/* Always-visible map. Centred on existing coords in edit mode,
                  on Hyderabad for new branches. Marker syncs to autocomplete
                  picks (see pickSuggestion); manual drags fire reverse-geocode
                  via handlePinDrop. */}
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
              <label>Delivery Radius (km)</label>
              <input
                type="number"
                value={form.deliveryRadiusKm}
                onChange={(e) => setField('deliveryRadiusKm', e.target.value)}
              />
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

          <div style={{ display: 'flex', gap: '.5rem', marginTop: '1rem' }}>
            <button type="button" className="btn-p" onClick={handleSave} disabled={saving}>
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
