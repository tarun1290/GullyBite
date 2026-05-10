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
    <div className="card mb-5">
      <div className="ch"><h3>Marketing &amp; Campaign Number (optional)</h3></div>
      <div className="cb">
        <p className="text-sm text-dim mt-0 mb-3.5 leading-normal">
          Choose a WABA phone number to use as the sender for marketing campaigns. Leave unset to
          fall back to your primary WhatsApp number.
        </p>

        {currentId ? (
          <div className="flex items-center gap-3 py-3 px-4 rounded-lg bg-surface2 mb-3.5">
            <span className="w-[10px] h-[10px] rounded-full bg-emerald-500 shrink-0" />
            <div className="flex-1">
              <div className="font-semibold text-base">Connected</div>
              <div className="text-sm text-dim">
                {currentName || currentId}
              </div>
            </div>
            <button
              type="button"
              className="btn-del"
              onClick={handleDisconnect}
              disabled={saving}
            >
              {saving ? '…' : 'Disconnect'}
            </button>
          </div>
        ) : (
          <div className="text-sm text-dim mb-3.5">
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
                className="py-1.5 px-2 border border-rim rounded-md text-sm min-w-[260px]"
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
            <span className="text-sm text-dim">
              No numbers returned by Meta.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
