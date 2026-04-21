import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import {
  getAutoJourneyConfig,
  updateAutoJourneyConfig,
  getAutoJourneyStats,
  getCampaignTemplates,
} from '../../api/restaurant.js';

// Auto journeys dashboard surface. Six journey cards, each with an
// enabled toggle and an inline Customise panel. Interactions are
// disabled until campaigns_enabled flips on the tenant wallet; the
// Loyalty Expiry card stays disabled regardless until Prompt 7 lands.

const JOURNEY_META = [
  {
    key: 'welcome',
    label: 'Welcome',
    description: 'Thank new customers 2 hours after their first order',
    icon: '\u{1F44B}',
  },
  {
    key: 'winback_short',
    label: 'Win-back',
    description: "Re-engage customers who haven't ordered in 14 days",
    icon: '\u{1F517}',
  },
  {
    key: 'reactivation',
    label: 'Reactivation',
    description: 'Last attempt to win back customers inactive for 30 days',
    icon: '\u{1F680}',
  },
  {
    key: 'birthday',
    label: 'Birthday',
    description: "Send a special offer on your customer's birthday",
    icon: '\u{1F382}',
  },
  {
    key: 'loyalty_expiry',
    label: 'Loyalty Expiry',
    description: 'Remind customers their points are about to expire',
    icon: '\u{23F3}',
    lockedUntilLoyalty: true,
  },
  {
    key: 'milestone',
    label: 'Milestone',
    description: 'Celebrate customers on their 5th, 10th, and 25th order',
    icon: '\u{1F389}',
  },
];

function Toggle({ checked, disabled, onChange }) {
  return (
    <label style={{
      display: 'inline-flex', alignItems: 'center',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.55 : 1,
    }}>
      <span style={{
        width: 36, height: 20, borderRadius: 12, position: 'relative',
        background: checked ? '#4f46e5' : '#cbd5e1',
        transition: 'background 120ms',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: checked ? 18 : 2,
          width: 16, height: 16, borderRadius: '50%', background: 'white',
          transition: 'left 120ms',
        }} />
      </span>
      <input
        type="checkbox" checked={checked} disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        style={{ display: 'none' }}
      />
    </label>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: '.7rem', color: 'var(--dim)' }}>{label}</div>
      <div style={{ fontWeight: 500, fontSize: '.92rem' }}>{value ?? '—'}</div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
      <span style={{ fontSize: '.78rem', color: '#334155' }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: '.72rem', color: 'var(--dim)' }}>{hint}</span>}
    </label>
  );
}

function JourneyCard({
  meta, config, stats, templates, onSave, savingKey, disabled, showStats,
}) {
  const [expanded, setExpanded] = useState(false);
  const key = meta.key;
  const entry = config[key] || {};
  const [local, setLocal] = useState(() => ({ ...entry }));

  useEffect(() => { setLocal({ ...entry }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [JSON.stringify(entry)]);

  const matchingTemplates = useMemo(
    () => (templates || []).filter((t) => t.use_case === key),
    [templates, key],
  );

  const saving = savingKey === key;
  // Loyalty is ALWAYS locked until Prompt 7; otherwise follow disabled.
  const toggleDisabled = disabled || meta.lockedUntilLoyalty;
  const customiseDisabled = disabled || meta.lockedUntilLoyalty;

  const updateLocal = (patch) => setLocal((prev) => ({ ...prev, ...patch }));

  const persistToggle = (enabled) => {
    onSave(key, { enabled });
  };

  const persistCustomise = () => {
    const payload = { ...local };
    // Normalise trigger_orders from comma string → int array if needed.
    if (key === 'milestone' && typeof payload.trigger_orders === 'string') {
      payload.trigger_orders = payload.trigger_orders
        .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    }
    onSave(key, payload);
  };

  return (
    <div className="card">
      <div className="cb" style={{ display: 'flex', flexDirection: 'column', gap: '.55rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start', flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '1.2rem' }}>{meta.icon}</div>
            <div>
              <strong>{meta.label}</strong>
              <div style={{ fontSize: '.78rem', color: 'var(--dim)' }}>{meta.description}</div>
            </div>
          </div>
          <Toggle
            checked={!!entry.enabled}
            disabled={toggleDisabled || saving}
            onChange={persistToggle}
          />
        </div>

        {meta.lockedUntilLoyalty && (
          <div className="notice" style={{ margin: 0 }}>
            <div className="notice-ico">{'\u{1F4CD}'}</div>
            <div className="notice-body">
              <p style={{ margin: 0, fontSize: '.78rem' }}>
                Activates automatically when the Loyalty program is set up.
              </p>
            </div>
          </div>
        )}

        <div style={{
          display: 'grid', gap: '.4rem',
          gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
          fontSize: '.82rem',
        }}>
          <Stat label="Sent (30d)"    value={showStats ? (stats?.total_sent ?? 0) : '—'} />
          <Stat label="Converted"     value={showStats ? (stats?.total_converted ?? 0) : '—'} />
          <Stat label="Conv rate"     value={showStats ? `${Number(stats?.conversion_rate || 0).toFixed(1)}%` : '—'} />
          <Stat label="Spend (30d)"   value={showStats ? `\u20B9${Number(stats?.total_cost_rs || 0).toFixed(2)}` : '—'} />
        </div>

        <button
          className="btn-g btn-sm"
          onClick={() => setExpanded((v) => !v)}
          disabled={customiseDisabled}
          style={{ alignSelf: 'flex-start' }}
        >
          {expanded ? 'Hide customise' : 'Customise'}
        </button>

        {expanded && !customiseDisabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.55rem', marginTop: '.25rem' }}>
            <Field label="Template">
              <select
                value={local.template_id || ''}
                onChange={(e) => updateLocal({ template_id: e.target.value || null })}
                style={{ padding: '.35rem .5rem', border: '1px solid #e5e7eb', borderRadius: 6 }}
              >
                <option value="">(System default)</option>
                {matchingTemplates.map((t) => (
                  <option key={t.template_id} value={t.template_id}>{t.display_name}</option>
                ))}
              </select>
            </Field>

            {(key === 'winback_short' || key === 'reactivation') && (
              <Field label="Inactivity trigger (days)">
                <input
                  type="number" min={1}
                  value={local.trigger_day ?? (key === 'winback_short' ? 14 : 30)}
                  onChange={(e) => updateLocal({ trigger_day: Number(e.target.value) })}
                  style={{ padding: '.35rem .5rem', border: '1px solid #e5e7eb', borderRadius: 6, width: 120 }}
                />
              </Field>
            )}

            {key === 'birthday' && (
              <Field label="Send hour (IST, 0-23)">
                <input
                  type="number" min={0} max={23}
                  value={local.send_hour_ist ?? 10}
                  onChange={(e) => updateLocal({ send_hour_ist: Number(e.target.value) })}
                  style={{ padding: '.35rem .5rem', border: '1px solid #e5e7eb', borderRadius: 6, width: 120 }}
                />
              </Field>
            )}

            {key === 'milestone' && (
              <Field
                label="Order milestones"
                hint="Comma separated. Defaults to 5, 10, 25."
              >
                <input
                  type="text"
                  value={Array.isArray(local.trigger_orders) ? local.trigger_orders.join(', ') : (local.trigger_orders || '')}
                  onChange={(e) => updateLocal({ trigger_orders: e.target.value })}
                  style={{ padding: '.35rem .5rem', border: '1px solid #e5e7eb', borderRadius: 6 }}
                />
              </Field>
            )}

            <TemplateVarOverrides
              template={matchingTemplates.find((t) => t.template_id === local.template_id)}
              values={local.custom_variable_values || {}}
              onChange={(v) => updateLocal({ custom_variable_values: v })}
            />

            <div>
              <button className="btn-p btn-sm" onClick={persistCustomise} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TemplateVarOverrides({ template, values, onChange }) {
  const inputs = (template?.variables || []).filter((v) => v.source === 'restaurant_input');
  if (!template || inputs.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '.35rem', paddingTop: '.3rem' }}>
      <div style={{ fontSize: '.78rem', color: '#334155' }}>Template variables</div>
      {inputs.map((v) => (
        <Field key={v.name} label={`${v.name}${v.required ? ' *' : ''}`}>
          <input
            type="text"
            placeholder={v.example || ''}
            value={values[v.name] || ''}
            onChange={(e) => onChange({ ...values, [v.name]: e.target.value })}
            style={{ padding: '.35rem .5rem', border: '1px solid #e5e7eb', borderRadius: 6 }}
          />
        </Field>
      ))}
    </div>
  );
}

export default function AutoJourneysSection({ campaignsEnabled }) {
  const { showToast } = useToast();
  const [config, setConfig] = useState(null);
  const [stats, setStats] = useState({ by_journey: {} });
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [cfg, st, tpls] = await Promise.all([
        getAutoJourneyConfig().catch(() => null),
        getAutoJourneyStats().catch(() => ({ by_journey: {} })),
        getCampaignTemplates().catch(() => []),
      ]);
      setConfig(cfg);
      setStats(st || { by_journey: {} });
      setTemplates(Array.isArray(tpls) ? tpls : []);
    } catch (err) {
      showToast(err?.message || 'Failed to load journeys', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = async (key, patch) => {
    setSavingKey(key);
    try {
      const updated = await updateAutoJourneyConfig({ [key]: patch });
      setConfig(updated);
      showToast('Saved', 'success');
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Save failed';
      showToast(msg, 'error');
    } finally {
      setSavingKey(null);
    }
  };

  if (loading || !config) {
    return <div style={{ color: 'var(--dim)', padding: '1rem' }}>Loading auto journeys…</div>;
  }

  const disabled = !campaignsEnabled;

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Auto Journeys</h2>
        <div style={{ fontSize: '.84rem', color: 'var(--dim)', marginTop: '.2rem' }}>
          Set-and-forget messages triggered by customer behaviour.
        </div>
      </div>

      {disabled && (
        <div className="notice wa" style={{ marginBottom: '1rem' }}>
          <div className="notice-ico">{'\u2728'}</div>
          <div className="notice-body">
            <h4>Coming Soon</h4>
            <p>
              Auto journeys run silently in the background once activated. The toggles below are
              locked until campaigns go live on your account.
            </p>
          </div>
        </div>
      )}

      <div
        style={{
          display: 'grid', gap: '.8rem',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          opacity: disabled ? 0.75 : 1,
        }}
      >
        {JOURNEY_META.map((meta) => (
          <JourneyCard
            key={meta.key}
            meta={meta}
            config={config}
            stats={stats.by_journey?.[meta.key]}
            templates={templates}
            onSave={onSave}
            savingKey={savingKey}
            disabled={disabled}
            showStats={!disabled}
          />
        ))}
      </div>
    </div>
  );
}
