'use client';

// Admin platform settings — global tunables that affect every
// restaurant. Today: WhatsApp marketing pricing. Future tabs would
// land here too (delivery_radius, owner_push_prefs surface, etc.).

import { useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import {
  getPlatformPricing,
  updatePlatformPricing,
  type PlatformPricing,
} from '../../../api/admin';

const PRICING_MIN = 1.0;
const PRICING_MAX = 3.0;

// Worked example used in the edit panel preview. Picks a typical
// India-market marketing rate so the operator can eyeball the
// resulting per-message charge without doing mental arithmetic.
const SAMPLE_META_RATE_RS = 0.65;

function formatMultiplierLabel(m: number): string {
  if (m === 1) return '1.0× (pass-through)';
  // Always show one decimal, sign always positive (multiplier is
  // gated >= 1.0 server-side).
  const pct = Math.round((m - 1) * 100);
  return `${m.toFixed(2)}× (+${pct}% margin)`;
}

export default function AdminSettingsPage() {
  const { showToast } = useToast();
  const [pricing, setPricing] = useState<PlatformPricing | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [editing, setEditing] = useState<boolean>(false);
  const [draftValue, setDraftValue] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getPlatformPricing();
      setPricing(data);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load pricing', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startEdit = () => {
    setDraftValue(pricing ? String(pricing.markup_multiplier) : '1.0');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraftValue('');
  };

  const onSave = async () => {
    const n = Number(draftValue);
    if (!Number.isFinite(n)) {
      showToast('Enter a valid number', 'error');
      return;
    }
    if (n < PRICING_MIN || n > PRICING_MAX) {
      showToast(`Multiplier must be between ${PRICING_MIN} and ${PRICING_MAX}`, 'error');
      return;
    }
    setSaving(true);
    try {
      const updated = await updatePlatformPricing({ markup_multiplier: n });
      setPricing(updated);
      setEditing(false);
      showToast('Pricing updated', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-dim p-4">Loading settings…</div>;
  }

  const draftNum = Number(draftValue);
  const draftValid = Number.isFinite(draftNum) && draftNum >= PRICING_MIN && draftNum <= PRICING_MAX;

  return (
    <div className="flex flex-col gap-4">
      <div className="card">
        <div className="ch">
          <h3>WhatsApp Message Pricing</h3>
          {!editing && (
            <button type="button" className="btn-g btn-sm" onClick={startEdit}>
              ✎ Edit
            </button>
          )}
        </div>
        <div className="cb">
          <p className="text-base text-dim mt-0 mb-3">
            Multiplier applied to every chargeable WhatsApp marketing send.
            <strong className="text-tx not-italic"> 1.0×</strong> charges restaurants exactly what Meta charges us.
            Higher values add a per-message platform margin.
          </p>

          {!editing ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-3">
                <div className="text-2xl font-bold text-tx">
                  {pricing ? formatMultiplierLabel(pricing.markup_multiplier) : '—'}
                </div>
              </div>
              {pricing?.updated_at && (
                <div className="text-sm text-dim">
                  Last updated {new Date(pricing.updated_at).toLocaleString()} {pricing.updated_by ? `by ${pricing.updated_by}` : ''}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-sm text-dim">
                  Markup multiplier (between {PRICING_MIN} and {PRICING_MAX})
                </label>
                <input
                  type="number"
                  step={0.01}
                  min={PRICING_MIN}
                  max={PRICING_MAX}
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                  className="w-full max-w-[200px] py-2 px-3 border border-rim rounded-md bg-white text-tx text-md"
                />
              </div>

              <div className="py-2 px-3 bg-ink2 border border-rim rounded-md text-sm">
                <div className="text-dim mb-1">Worked example</div>
                {draftValid ? (
                  <>
                    <span className="text-tx">
                      Meta charges ₹{SAMPLE_META_RATE_RS.toFixed(2)}
                    </span>
                    <span className="text-dim"> → restaurant pays </span>
                    <strong className="text-tx not-italic">
                      ₹{(SAMPLE_META_RATE_RS * draftNum).toFixed(2)}
                    </strong>
                    {draftNum > 1 && (
                      <span className="text-dim">
                        {' '}(₹{((SAMPLE_META_RATE_RS * draftNum) - SAMPLE_META_RATE_RS).toFixed(2)} platform margin per message)
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-amber-900">
                    Enter a value between {PRICING_MIN} and {PRICING_MAX} to preview
                  </span>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-p btn-sm"
                  onClick={onSave}
                  disabled={saving || !draftValid}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="btn-g btn-sm"
                  onClick={cancelEdit}
                  disabled={saving}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="mt-4 py-2 px-3 bg-amber-50 border border-yellow-200 rounded-md text-sm text-amber-900">
            <strong className="not-italic">Note:</strong> changes take effect on the next campaign create + send.
            In-flight campaigns that have already started their recipient loop continue with the value
            snapshotted at send-start.
          </div>
        </div>
      </div>
    </div>
  );
}
