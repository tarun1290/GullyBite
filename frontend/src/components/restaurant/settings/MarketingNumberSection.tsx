'use client';

import { useState } from 'react';
import { useRestaurant } from '../../../contexts/RestaurantContext';
import { useToast } from '../../Toast';
import { getWabaNumbers, setMarketingNumber } from '../../../api/restaurant';
import type { Restaurant } from '../../../types';

interface RestaurantWithMarketing extends Restaurant {
  marketingPhoneNumberId?: string | null;
  marketingPhoneDisplayName?: string | null;
}

interface WabaNumber {
  id: string | number;
  display_phone_number?: string;
  verified_name?: string;
}

interface WabaNumbersResponse {
  numbers?: WabaNumber[];
}

export default function MarketingNumberSection() {
  const { restaurant, refetch } = useRestaurant();
  const { showToast } = useToast();
  const [numbers, setNumbers] = useState<WabaNumber[] | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [selectedId, setSelectedId] = useState<string>('');

  const r: RestaurantWithMarketing = (restaurant as RestaurantWithMarketing) || {};
  const restaurantId = r.id;
  const currentId = r.marketingPhoneNumberId || null;
  const currentName = r.marketingPhoneDisplayName || null;

  if (!restaurantId) return null;

  const handleLoad = async () => {
    setLoading(true);
    try {
      const data = (await getWabaNumbers(restaurantId)) as WabaNumbersResponse | null;
      const list = Array.isArray(data?.numbers) ? data.numbers : [];
      setNumbers(list);
      if (!list.length) {
        showToast('No phone numbers found on this WABA', 'info');
      } else if (currentId) {
        const hit = list.find((n) => String(n.id) === String(currentId));
        if (hit) setSelectedId(String(hit.id));
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load numbers', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!selectedId) { showToast('Pick a number first', 'error'); return; }
    const match = (numbers || []).find((n) => String(n.id) === String(selectedId));
    const displayName = match ? `${match.display_phone_number} — ${match.verified_name || ''}`.trim() : null;
    setSaving(true);
    try {
      await setMarketingNumber(restaurantId, { phoneNumberId: selectedId, displayName });
      showToast('Marketing number saved', 'success');
      await refetch();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
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
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Disconnect failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card mb-[1.2rem]">
      <div className="ch"><h3>Marketing &amp; Campaign Number (optional)</h3></div>
      <div className="cb">
        <p className="text-[0.78rem] text-dim mt-0 mb-[0.9rem] leading-normal">
          Choose a WABA phone number to use as the sender for marketing campaigns. Leave unset to
          fall back to your primary WhatsApp number.
        </p>

        {currentId ? (
          <div className="flex items-center gap-[0.8rem] py-[0.7rem] px-4 rounded-lg bg-surface2 mb-[0.9rem]">
            <span className="w-[10px] h-[10px] rounded-full bg-[#22c55e] shrink-0" />
            <div className="flex-1">
              <div className="font-semibold text-[0.88rem]">Connected</div>
              <div className="text-[0.78rem] text-dim">
                {currentName || currentId}
              </div>
            </div>
            <button
              type="button"
              className="btn-g btn-sm text-[#dc2626] border-[#dc2626]"
              onClick={handleDisconnect}
              disabled={saving}
            >
              {saving ? '…' : 'Disconnect'}
            </button>
          </div>
        ) : (
          <div className="text-[0.78rem] text-dim mb-[0.9rem]">
            No marketing number set.
          </div>
        )}

        <div className="flex gap-2 flex-wrap items-center">
          <button
            type="button"
            className="btn-g btn-sm"
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
                className="py-[0.35rem] px-[0.55rem] border border-rim rounded-md text-[0.82rem] min-w-[260px]"
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
            <span className="text-[0.78rem] text-dim">
              No numbers returned by Meta.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
