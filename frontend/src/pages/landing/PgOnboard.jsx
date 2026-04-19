import { useState } from 'react';
import client from '../../api/client.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';

export default function PgOnboard({ onLogout, onAdvance, onBrandNameChange }) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const [ownerName, setOwnerName] = useState(user?.owner_name || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [brandName, setBrandName] = useState(user?.brand_name || '');
  const [city, setCity] = useState(user?.city || '');
  const [restaurantType, setRestaurantType] = useState(user?.restaurant_type || 'both');
  const [gstNumber, setGstNumber] = useState(user?.gst_number || '');
  const [fssaiLicense, setFssaiLicense] = useState(user?.fssai_license || '');

  const handleBrandInput = (e) => {
    const next = e.target.value;
    setBrandName(next);
    onBrandNameChange?.(next.trim() || null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const { data } = await client.post('/auth/onboarding', {
        ownerName: ownerName.trim(),
        phone: phone.trim(),
        brandName: brandName.trim(),
        restaurantType,
        city: city.trim(),
        gstNumber: gstNumber.trim().toUpperCase() || null,
        fssaiLicense: fssaiLicense.trim() || null,
      });
      if (data?.submitted) {
        showToast('Details saved! Now connect your WhatsApp.', 'success');
        onAdvance?.();
      } else {
        showToast(data?.error || 'Save failed', 'error');
      }
    } catch (err) {
      showToast(err?.userMessage || err?.message || 'Save failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="pg-onboard" className="auth-wrap">
      <nav className="nav" style={{ position: 'relative' }}>
        <div className="logo"><div className="logo-ring">🍜</div>GullyBite</div>
        <button
          type="button"
          className="btn-outline"
          style={{ fontSize: '.76rem', padding: '.42rem .95rem' }}
          onClick={onLogout}
        >
          Sign out
        </button>
      </nav>
      <div className="auth-body" style={{ alignItems: 'flex-start', paddingTop: '1.5rem' }}>
        <div className="ob-wrap">
          <div className="ob-header">
            <h2>Tell us about your restaurant</h2>
            <p>Quick setup — takes less than a minute.</p>
          </div>
          <div className="ob-steps">
            <div className="ob-step-item">
              <div className="ob-step-dot done">✓</div>
              <div className="ob-step-label">Account</div>
            </div>
            <div className="ob-connector done"></div>
            <div className="ob-step-item">
              <div className="ob-step-dot active">2</div>
              <div className="ob-step-label active">Restaurant Info</div>
            </div>
            <div className="ob-connector"></div>
            <div className="ob-step-item">
              <div className="ob-step-dot">3</div>
              <div className="ob-step-label">Connect WhatsApp</div>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="ob-section">
              <div className="fld-row">
                <div className="fld">
                  <label>Your Full Name <span className="req">*</span></label>
                  <input
                    type="text"
                    placeholder="Ravi Kumar"
                    required
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                  />
                </div>
                <div className="fld">
                  <label>Phone Number <span className="req">*</span></label>
                  <input
                    type="tel"
                    placeholder="+91 98765 43210"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
              </div>
              <div className="fld">
                <label>
                  Restaurant Name <span className="req">*</span>{' '}
                  <span style={{ fontWeight: 400, color: 'var(--mute)' }}>(as customers will see it)</span>
                </label>
                <input
                  type="text"
                  placeholder="Spice Route Kitchen"
                  required
                  value={brandName}
                  onChange={handleBrandInput}
                />
              </div>
              <div className="fld-row">
                <div className="fld">
                  <label>City <span className="req">*</span></label>
                  <input
                    type="text"
                    placeholder="Bengaluru"
                    required
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                  />
                </div>
                <div className="fld">
                  <label>Restaurant Type</label>
                  <select
                    value={restaurantType}
                    onChange={(e) => setRestaurantType(e.target.value)}
                  >
                    <option value="both">Veg &amp; Non-Veg</option>
                    <option value="veg">Pure Veg</option>
                    <option value="non_veg">Non-Veg Only</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="ob-section">
              <div className="ob-section-title">Legal &amp; Compliance (Optional)</div>
              <div className="fld-row">
                <div className="fld">
                  <label>GST Number</label>
                  <input
                    type="text"
                    placeholder="22AAAAA0000A1Z5"
                    maxLength={15}
                    style={{ textTransform: 'uppercase' }}
                    value={gstNumber}
                    onChange={(e) => setGstNumber(e.target.value)}
                  />
                </div>
                <div className="fld">
                  <label>FSSAI License Number</label>
                  <input
                    type="text"
                    placeholder="12345678901234"
                    maxLength={14}
                    value={fssaiLicense}
                    onChange={(e) => setFssaiLicense(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <button type="submit" className="ob-submit" disabled={busy}>
              {busy ? (<><span className="spin" /> Saving…</>) : 'Continue → Connect WhatsApp'}
            </button>
            <p className="ob-note">GST and FSSAI can also be updated later in your dashboard settings.</p>
          </form>
        </div>
      </div>
    </div>
  );
}
