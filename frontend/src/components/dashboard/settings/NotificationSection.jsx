import { useEffect, useState } from 'react';
import Field from '../../Field.jsx';
import { useRestaurant } from '../../../contexts/RestaurantContext.jsx';
import { useToast } from '../../Toast.jsx';
import { updateRestaurantProfile } from '../../../api/restaurant.js';

// Mirrors loadProfile()'s notification block + doSaveNotifySettings() in legacy
// settings.js:606-614 + 730-743.

const EVENTS = [
  ['new_order', 'New order received', true],
  ['payment', 'Payment received', true],
  ['cancelled', 'Order cancelled', true],
  ['low_activity', 'Low activity (no orders 2 hrs)', false],
];

function buildForm(r) {
  const ns = r?.notification_settings || {};
  const phones = Array.isArray(r?.notification_phones) ? r.notification_phones.join(', ') : '';
  return {
    phones,
    new_order: ns.new_order !== undefined ? ns.new_order : true,
    payment: ns.payment !== undefined ? ns.payment : true,
    cancelled: ns.cancelled !== undefined ? ns.cancelled : true,
    low_activity: ns.low_activity !== undefined ? ns.low_activity : false,
  };
}

function Pill({ on, label }) {
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
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => buildForm(null));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (restaurant) setForm(buildForm(restaurant));
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
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Save failed', 'error');
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

  const r = restaurant || {};
  const phones = Array.isArray(r.notification_phones) && r.notification_phones.length
    ? r.notification_phones.join(', ')
    : null;
  const ns = r.notification_settings || {};

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
                onClick={() => { setForm(buildForm(restaurant)); setEditing(false); }}
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
