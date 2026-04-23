import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import { createBranch, updateBranch, placesAutocomplete, placesDetails } from '../../../api/restaurant.js';

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
  const searchTimer = useRef(null);

  useEffect(() => {
    if (open) {
      setForm(isEdit ? formFromBranch(existingBranch) : emptyForm());
      setSuggestions([]);
      setShowSuggest(false);
    }
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, existingBranch]);

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
