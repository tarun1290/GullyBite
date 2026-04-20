import { useState } from 'react';
import { useRestaurant } from '../../../contexts/RestaurantContext.jsx';
import { useToast } from '../../Toast.jsx';
import { getWabaNumbers, setMarketingNumber } from '../../../api/restaurant.js';

// Marketing & Campaign Number picker. Lives under WhatsappSection on the
// owner dashboard Settings → WhatsApp tab. Backed by the restaurant's
// marketingPhoneNumberId / marketingPhoneDisplayName fields and the
// /:id/waba-numbers + /:id/marketing-number endpoints.

export default function MarketingNumberSection() {
  const { restaurant, refetch } = useRestaurant();
  const { showToast } = useToast();
  const [numbers, setNumbers] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState('');

  const r = restaurant || {};
  const restaurantId = r.id;
  const currentId = r.marketingPhoneNumberId || null;
  const currentName = r.marketingPhoneDisplayName || null;

  if (!restaurantId) return null;

  const handleLoad = async () => {
    setLoading(true);
    try {
      const data = await getWabaNumbers(restaurantId);
      const list = Array.isArray(data?.numbers) ? data.numbers : [];
      setNumbers(list);
      if (!list.length) {
        showToast('No phone numbers found on this WABA', 'info');
      } else if (currentId) {
        const hit = list.find((n) => String(n.id) === String(currentId));
        if (hit) setSelectedId(String(hit.id));
      }
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to load numbers', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!selectedId) return showToast('Pick a number first', 'error');
    const match = (numbers || []).find((n) => String(n.id) === String(selectedId));
    const displayName = match ? `${match.display_phone_number} — ${match.verified_name || ''}`.trim() : null;
    setSaving(true);
    try {
      await setMarketingNumber(restaurantId, { phoneNumberId: selectedId, displayName });
      showToast('Marketing number saved', 'success');
      await refetch();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setSaving(true);
    try {
      await setMarketingNumber(restaurantId, { phoneNumberId: null });
      showToast('Marketing number disconnected', 'success');
      setNumbers(null);
      setSelectedId('');
      await refetch();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Disconnect failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch"><h3>Marketing &amp; Campaign Number (optional)</h3></div>
      <div className="cb">
        <p style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: 0, marginBottom: '.9rem', lineHeight: 1.5 }}>
          Choose a WABA phone number to use as the sender for marketing campaigns. Leave unset to
          fall back to your primary WhatsApp number.
        </p>

        {currentId ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '.8rem', padding: '.7rem 1rem',
            borderRadius: 8, background: 'var(--surface2,#f4f4f5)', marginBottom: '.9rem',
          }}
          >
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '.88rem' }}>Connected</div>
              <div style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
                {currentName || currentId}
              </div>
            </div>
            <button
              type="button"
              className="btn-g btn-sm"
              style={{ color: '#dc2626', borderColor: '#dc2626' }}
              onClick={handleDisconnect}
              disabled={saving}
            >
              {saving ? '…' : 'Disconnect'}
            </button>
          </div>
        ) : (
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginBottom: '.9rem' }}>
            No marketing number set.
          </div>
        )}

        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            className="btn-sm"
            onClick={handleLoad}
            disabled={loading || saving}
          >
            {loading ? 'Loading…' : numbers ? '↻ Reload numbers' : 'Load available numbers'}
          </button>

          {numbers && numbers.length > 0 && (
            <>
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                disabled={saving}
                style={{
                  padding: '.35rem .55rem', border: '1px solid var(--rim)',
                  borderRadius: 6, fontSize: '.82rem', minWidth: 260,
                }}
              >
                <option value="">— Select a number —</option>
                {numbers.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.display_phone_number}{n.verified_name ? ` — ${n.verified_name}` : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-p btn-sm"
                onClick={handleSave}
                disabled={saving || !selectedId}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}

          {numbers && numbers.length === 0 && (
            <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
              No numbers returned by Meta.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
