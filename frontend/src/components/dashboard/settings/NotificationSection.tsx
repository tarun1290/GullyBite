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
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '.2rem',
        fontSize: '.72rem', fontWeight: 600, padding: '.2rem .5rem',
        borderRadius: 99,
        background: on ? '#dcfce7' : 'var(--ink2)',
        color: on ? '#15803d' : 'var(--dim)',
      }}
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
        <div className="cb"><div style={{ color: 'var(--dim)', padding: '.5rem' }}>Loading…</div></div>
      </div>
    );
  }

  const r: RestaurantWithNotify = (restaurant as RestaurantWithNotify) || {};
  const phones = Array.isArray(r.notification_phones) && r.notification_phones.length
    ? r.notification_phones.join(', ')
    : null;
  const ns: NotificationSettings = r.notification_settings || {};

  return (
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch" style={{ justifyContent: 'space-between' }}>
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
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '.45rem 0', borderBottom: '1px solid var(--rim,#f0f0f0)',
            }}
            >
              <span style={{ color: 'var(--dim)', fontSize: '.78rem', minWidth: 130 }}>
                Notification Phones
              </span>
              <span style={{
                fontWeight: 500, textAlign: 'right', fontSize: '.84rem',
                color: phones ? 'inherit' : 'var(--mute,var(--dim))',
                fontStyle: phones ? 'normal' : 'italic',
              }}
              >
                {phones || 'Not configured'}
              </span>
            </div>
            <p style={{
              fontSize: '.78rem', fontWeight: 600, color: 'var(--dim)', margin: '.5rem 0 .4rem',
            }}
            >
              Events:
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem' }}>
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
            <p style={{ fontSize: '.84rem', fontWeight: 600, color: 'var(--dim)', marginBottom: '.7rem' }}>
              Notify me when:
            </p>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: '1.2rem', marginBottom: '.5rem',
            }}
            >
              {EVENTS.map(([key, label]) => (
                <label
                  key={key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '.4rem',
                    fontSize: '.84rem', cursor: 'pointer',
                  }}
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

            <div style={{ display: 'flex', gap: '.5rem', marginTop: '.8rem' }}>
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
