import { useCallback, useEffect, useState } from 'react';
import StatCard from '../../components/StatCard.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import { useRestaurant } from '../../contexts/RestaurantContext.jsx';
import {
  getLoyaltyProgramConfig,
  updateLoyaltyProgramConfig,
  getLoyaltyProgramStats,
  lookupLoyaltyCustomer,
  creditLoyaltyDineIn,
} from '../../api/restaurant.js';

// Loyalty Program tab.
// Three sections: Program Overview (stats + activate toggle), Program
// Settings (config form), Dine-in Points Entry (phone + points +
// description). Backed by the unified loyaltyEngine (loyalty_config +
// loyalty_points + loyalty_transactions) via
// /api/restaurant/loyalty-program/*.

const CONFIG_FIELDS = [
  { key: 'program_name',             label: 'Program name',                      type: 'text',   step: null },
  { key: 'points_per_rupee',         label: 'Points per ₹1',                     type: 'number', step: '0.01' },
  { key: 'first_order_multiplier',   label: 'First-order multiplier',            type: 'number', step: '0.1' },
  { key: 'birthday_week_multiplier', label: 'Birthday-week multiplier',          type: 'number', step: '0.1' },
  { key: 'referral_bonus_points',    label: 'Referral bonus (points)',           type: 'number', step: '1' },
  { key: 'min_points_to_redeem',     label: 'Minimum points to redeem',          type: 'number', step: '1' },
  { key: 'max_redemption_percent',   label: 'Max redemption % of cart',          type: 'number', step: '1' },
  { key: 'points_to_rupee_ratio',    label: 'Points per ₹1 discount',            type: 'number', step: '1' },
  { key: 'max_redemptions_per_day',  label: 'Max redemptions per day',           type: 'number', step: '1' },
  { key: 'points_expiry_days',       label: 'Points expire after (days)',        type: 'number', step: '1' },
  { key: 'expiry_warning_days',      label: 'Expiry warning window (days)',      type: 'number', step: '1' },
];

function ProgramOverview({ stats, loading, err, onRetry, onToggleActive, config, savingActive }) {
  if (err) return <SectionError message={err} onRetry={onRetry} />;
  const redemptionRatePct = Math.round(((stats?.redemption_rate || 0) * 100) * 10) / 10;
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Program Overview</h3>
          <button
            type="button"
            className={config?.is_active ? 'btn-g btn-sm' : 'btn-p btn-sm'}
            disabled={savingActive || !config}
            onClick={() => onToggleActive(!config?.is_active)}
            style={{ marginLeft: 'auto' }}
          >
            {savingActive
              ? 'Saving…'
              : config?.is_active ? 'Pause program' : 'Activate program'}
          </button>
        </div>
        <div className="cb">
          <div style={{ fontSize: '.84rem', color: 'var(--dim)' }}>
            {config?.is_active
              ? 'Points are being issued on paid orders and redeemed pre-checkout.'
              : 'Program is paused. No earn or redeem activity will occur until activated.'}
          </div>
        </div>
      </div>

      <div className="stats">
        <StatCard
          label="Total members"
          value={loading ? '—' : (stats?.total_members || 0).toLocaleString()}
          delta="Customers with a ledger"
        />
        <StatCard
          label="Points issued"
          value={loading ? '—' : (stats?.total_points_issued || 0).toLocaleString()}
          delta="Lifetime"
        />
        <StatCard
          label="Points redeemed"
          value={loading ? '—' : (stats?.total_points_redeemed || 0).toLocaleString()}
          delta="Lifetime"
        />
        <StatCard
          label="Est. liability"
          value={loading ? '—' : `\u20B9${(stats?.estimated_liability_rs || 0).toLocaleString()}`}
          delta="Points outstanding × redeem ratio"
        />
        <StatCard
          label="Redemption rate"
          value={loading ? '—' : `${redemptionRatePct}%`}
          delta="Redeemed ÷ issued"
        />
      </div>
    </div>
  );
}

function ProgramSettings({ config, onSave, saving, disabled }) {
  const [draft, setDraft] = useState(() => config ? { ...config } : {});

  useEffect(() => {
    if (config) setDraft({ ...config });
  }, [config]);

  function update(key, raw) {
    setDraft((d) => ({ ...d, [key]: raw }));
  }

  async function submit(e) {
    e.preventDefault();
    const patch = {};
    for (const f of CONFIG_FIELDS) {
      const v = draft[f.key];
      if (v === undefined || v === null || v === '') continue;
      patch[f.key] = f.type === 'number' ? Number(v) : v;
    }
    await onSave(patch);
  }

  return (
    <form
      className="card"
      onSubmit={submit}
      style={{
        marginBottom: '1rem',
        opacity: disabled ? 0.6 : 1,
        pointerEvents: disabled ? 'none' : 'auto',
      }}
    >
      <div className="ch"><h3>Program Settings</h3></div>
      <div
        className="cb"
        style={{
          display: 'grid', gap: '.8rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        }}
      >
        {CONFIG_FIELDS.map((f) => (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
            <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>{f.label}</span>
            <input
              type={f.type}
              step={f.step || undefined}
              value={draft[f.key] ?? ''}
              onChange={(e) => update(f.key, e.target.value)}
              disabled={disabled}
              style={{
                padding: '.45rem .55rem',
                border: '1px solid var(--rim)',
                borderRadius: 'var(--r)',
                background: '#fff',
              }}
            />
          </label>
        ))}
      </div>
      <div className="cb" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="submit"
          className="btn-p btn-sm"
          disabled={saving || disabled}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}

function DineInEntry({ onCredit, disabled }) {
  const [phone, setPhone] = useState('');
  const [points, setPoints] = useState('');
  const [description, setDescription] = useState('');
  const [lookupResult, setLookupResult] = useState(null);
  const [lookupErr, setLookupErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function onLookup() {
    setLookupErr(null);
    setLookupResult(null);
    if (!phone.trim()) return;
    try {
      const res = await lookupLoyaltyCustomer(phone.trim());
      setLookupResult(res);
    } catch (err) {
      const reason = err?.response?.data?.error || err?.message || 'Lookup failed';
      setLookupErr(reason === 'customer_not_found' ? 'No customer found with this phone' : reason);
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    setMsg(null);
    const p = Math.floor(Number(points) || 0);
    if (!phone.trim() || p <= 0) {
      setMsg({ kind: 'err', text: 'Phone and positive points are required' });
      return;
    }
    setBusy(true);
    try {
      const res = await onCredit({ phone: phone.trim(), points: p, description: description.trim() || undefined });
      setMsg({ kind: 'ok', text: `Credited ${res.awarded} points. New balance: ${res.balance}.` });
      setPoints('');
      setDescription('');
      await onLookup(); // refresh lookup card
    } catch (err) {
      const reason = err?.response?.data?.error || err?.message || 'Credit failed';
      setMsg({ kind: 'err', text: reason === 'customer_not_found' ? 'No customer found with this phone' : reason });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="card"
      onSubmit={onSubmit}
      style={{
        opacity: disabled ? 0.6 : 1,
        pointerEvents: disabled ? 'none' : 'auto',
      }}
    >
      <div className="ch"><h3>Dine-in Points Entry</h3></div>
      <div
        className="cb"
        style={{
          display: 'grid', gap: '.8rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Customer phone</span>
          <div style={{ display: 'flex', gap: '.35rem' }}>
            <input
              type="tel"
              inputMode="numeric"
              placeholder="91XXXXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={onLookup}
              disabled={disabled}
              style={{
                flex: 1,
                padding: '.45rem .55rem',
                border: '1px solid var(--rim)',
                borderRadius: 'var(--r)',
                background: '#fff',
              }}
            />
            <button
              type="button"
              className="btn-g btn-sm"
              onClick={onLookup}
              disabled={disabled || !phone.trim()}
            >
              Check
            </button>
          </div>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Points to credit</span>
          <input
            type="number"
            min="1"
            step="1"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            disabled={disabled}
            style={{
              padding: '.45rem .55rem',
              border: '1px solid var(--rim)',
              borderRadius: 'var(--r)',
              background: '#fff',
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Description (optional)</span>
          <input
            type="text"
            placeholder="e.g. Walk-in order #24"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={disabled}
            style={{
              padding: '.45rem .55rem',
              border: '1px solid var(--rim)',
              borderRadius: 'var(--r)',
              background: '#fff',
            }}
          />
        </label>
      </div>

      {(lookupResult || lookupErr) && (
        <div className="cb">
          {lookupErr ? (
            <div style={{ color: 'var(--red)', fontSize: '.82rem' }}>{lookupErr}</div>
          ) : (
            <div
              style={{
                padding: '.55rem .65rem',
                border: '1px solid var(--rim)',
                borderRadius: 'var(--r)',
                fontSize: '.82rem',
                background: 'var(--panel)',
              }}
            >
              <strong>{lookupResult.customer?.name || 'Customer'}</strong>
              <span style={{ color: 'var(--dim)', marginLeft: '.4rem' }}>
                {lookupResult.customer?.wa_phone_masked || ''}
              </span>
              <div style={{ marginTop: '.25rem' }}>
                Balance: <strong>{lookupResult.balance}</strong> pts · Earned: {lookupResult.total_earned} · Redeemed: {lookupResult.total_redeemed}
              </div>
            </div>
          )}
        </div>
      )}

      {msg && (
        <div
          className="cb"
          style={{
            color: msg.kind === 'ok' ? 'var(--wa)' : 'var(--red)',
            fontSize: '.82rem',
          }}
        >
          {msg.text}
        </div>
      )}

      <div className="cb" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" className="btn-p btn-sm" disabled={busy || disabled}>
          {busy ? 'Crediting…' : 'Credit points'}
        </button>
      </div>
    </form>
  );
}

export default function LoyaltyTab() {
  const { restaurant } = useRestaurant();
  const campaignsEnabled = !!restaurant?.campaigns_enabled;

  const [config, setConfig] = useState(null);
  const [configErr, setConfigErr] = useState(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingActive, setSavingActive] = useState(false);

  const [stats, setStats] = useState(null);
  const [statsErr, setStatsErr] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigErr(null);
    try {
      const data = await getLoyaltyProgramConfig();
      setConfig(data || null);
    } catch (err) {
      setConfigErr(err?.userMessage || err?.message || 'Could not load program settings');
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsErr(null);
    try {
      const data = await getLoyaltyProgramStats();
      setStats(data || null);
    } catch (err) {
      setStatsErr(err?.userMessage || err?.message || 'Could not load program stats');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadStats(); }, [loadStats]);

  async function onSaveConfig(patch) {
    setSaving(true);
    try {
      const next = await updateLoyaltyProgramConfig(patch);
      setConfig(next);
    } catch (err) {
      const reason = err?.response?.data?.error || err?.message || 'Save failed';
      // eslint-disable-next-line no-alert
      alert(`Could not save: ${reason}`);
    } finally {
      setSaving(false);
    }
  }

  async function onToggleActive(nextActive) {
    setSavingActive(true);
    try {
      const next = await updateLoyaltyProgramConfig({ is_active: !!nextActive });
      setConfig(next);
    } catch (err) {
      const reason = err?.response?.data?.error || err?.message || 'Update failed';
      // eslint-disable-next-line no-alert
      alert(`Could not update program state: ${reason}`);
    } finally {
      setSavingActive(false);
    }
  }

  async function onDineInCredit(body) {
    const res = await creditLoyaltyDineIn(body);
    await loadStats();
    return res;
  }

  return (
    <div id="tab-loyalty" className="tab on">
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Loyalty</h2>
        <div style={{ fontSize: '.84rem', color: 'var(--dim)', marginTop: '.2rem' }}>
          Points earn automatically on paid orders; customers can redeem pre-checkout.
        </div>
      </div>

      {!campaignsEnabled && (
        <div className="notice wa" style={{ marginBottom: '1rem' }}>
          <div className="notice-ico">{'\u2728'}</div>
          <div className="notice-body">
            <h4>Coming Soon</h4>
            <p>
              The loyalty program is locked until campaigns go live on your account. Settings below
              are read-only in the meantime.
            </p>
          </div>
        </div>
      )}

      {configErr ? (
        <div style={{ marginBottom: '1rem' }}>
          <SectionError message={configErr} onRetry={loadConfig} />
        </div>
      ) : (
        <>
          <ProgramOverview
            stats={stats}
            loading={statsLoading}
            err={statsErr}
            onRetry={loadStats}
            onToggleActive={onToggleActive}
            config={config}
            savingActive={savingActive}
          />
          <ProgramSettings
            config={config}
            onSave={onSaveConfig}
            saving={saving || configLoading}
            disabled={!campaignsEnabled}
          />
          <DineInEntry onCredit={onDineInCredit} disabled={!campaignsEnabled} />
        </>
      )}
    </div>
  );
}
