'use client';

import { useEffect, useState } from 'react';
import Field from '../../Field';
import { useRestaurant } from '../../../contexts/RestaurantContext';
import { useToast } from '../../Toast';
import { updateRestaurantProfile } from '../../../api/restaurant';
import type { Restaurant } from '../../../types';

interface NotificationSettings {
  new_order?: boolean;
  payment?: boolean;
  cancelled?: boolean;
  low_activity?: boolean;
}

interface RestaurantWithNotify extends Restaurant {
  notification_settings?: NotificationSettings;
  notification_phones?: string[];
}

interface FormState {
  phones: string;
  new_order: boolean;
  payment: boolean;
  cancelled: boolean;
  low_activity: boolean;
}

const EVENTS: ReadonlyArray<readonly [keyof FormState, string]> = [
  ['new_order', 'New order received'],
  ['payment', 'Payment received'],
  ['cancelled', 'Order cancelled'],
  ['low_activity', 'Low activity (no orders 2 hrs)'],
];

function buildForm(r: RestaurantWithNotify | null): FormState {
  const ns = r?.notification_settings || {};
  const phones = Array.isArray(r?.notification_phones) ? (r?.notification_phones || []).join(', ') : '';
  return {
    phones,
    new_order: ns.new_order !== undefined ? !!ns.new_order : true,
    payment: ns.payment !== undefined ? !!ns.payment : true,
    cancelled: ns.cancelled !== undefined ? !!ns.cancelled : true,
    low_activity: ns.low_activity !== undefined ? !!ns.low_activity : false,
  };
}

interface PillProps { on: boolean; label: string }

function Pill({ on, label }: PillProps) {
  return (
    <span
      className={`inline-flex items-center gap-[0.2rem] text-[0.72rem] font-semibold py-[0.2rem] px-2 rounded-full ${
        on ? 'bg-[#dcfce7] text-[#15803d]' : 'bg-ink2 text-dim'
      }`}
    >
      {on ? '✅ ' : ''}
      {label}
    </span>
  );
}

export default function NotificationSection() {
  const { restaurant, loading, refetch } = useRestaurant();
  const { showToast } = useToast();
  const [editing, setEditing] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(() => buildForm(null));
  const [saving, setSaving] = useState<boolean>(false);

  useEffect(() => {
    if (restaurant) setForm(buildForm(restaurant as RestaurantWithNotify));
  }, [restaurant]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const notificationPhones = form.phones.split(',').map((p) => p.trim()).filter(Boolean);
      await updateRestaurantProfile({
        notificationPhones,
        notificationSettings: {
          new_order: !!form.new_order,
          payment: !!form.payment,
          cancelled: !!form.cancelled,
          low_activity: !!form.low_activity,
        },
      });
      showToast('Notification settings saved', 'success');
      await refetch();
      setEditing(false);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !restaurant) {
    return (
      <div className="card">
        <div className="ch"><h3>🔔 Notification Settings</h3></div>
        <div className="cb"><div className="text-dim p-2">Loading…</div></div>
      </div>
    );
  }

  const r: RestaurantWithNotify = (restaurant as RestaurantWithNotify) || {};
  const phones = Array.isArray(r.notification_phones) && r.notification_phones.length
    ? r.notification_phones.join(', ')
    : null;
  const ns: NotificationSettings = r.notification_settings || {};

  return (
    <div className="card mb-[1.2rem]">
      <div className="ch justify-between">
        <h3>🔔 Notification Settings</h3>
        {!editing && (
          <button type="button" className="btn-g btn-sm" onClick={() => setEditing(true)}>
            ✎ Edit
          </button>
        )}
      </div>
      <div className="cb">
        {!editing ? (
          <div>
            <div className="flex justify-between items-center py-[0.45rem] border-b border-rim">
              <span className="text-dim text-[0.78rem] min-w-[130px]">
                Notification Phones
              </span>
              <span
                className={`font-medium text-right text-[0.84rem] ${
                  phones ? 'not-italic' : 'text-mute italic'
                }`}
              >
                {phones || 'Not configured'}
              </span>
            </div>
            <p className="text-[0.78rem] font-semibold text-dim mt-2 mb-[0.4rem]">
              Events:
            </p>
            <div className="flex flex-wrap gap-[0.4rem]">
              <Pill on={ns.new_order !== false} label="New Orders" />
              <Pill on={ns.payment !== false} label="Payments" />
              <Pill on={ns.cancelled !== false} label="Cancellations" />
              <Pill on={!!ns.low_activity} label="Low Activity" />
            </div>
          </div>
        ) : (
          <div>
            <div className="fgrid">
              <Field
                label="Owner Notification Phones"
                className="span2"
                hint="With country code, no + prefix"
              >
                <input
                  value={form.phones}
                  onChange={(e) => setForm((p) => ({ ...p, phones: e.target.value }))}
                  placeholder="919876543210, 919876543211 (comma-separated)"
                />
              </Field>
            </div>
            <hr className="dv" />
            <p className="text-[0.84rem] font-semibold text-dim mb-[0.7rem]">
              Notify me when:
            </p>
            <div className="flex flex-wrap gap-[1.2rem] mb-2">
              {EVENTS.map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center gap-[0.4rem] text-[0.84rem] cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={!!form[key]}
                    onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </div>

            <div className="flex gap-2 mt-[0.8rem]">
              <button
                type="button"
                className="btn-p"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save Notification Settings'}
              </button>
              <button
                type="button"
                className="btn-g"
                onClick={() => { setForm(buildForm(restaurant as RestaurantWithNotify)); setEditing(false); }}
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
