'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import { useRestaurant } from '../../../contexts/RestaurantContext';
import {
  getLoyaltyProgramConfig,
  updateLoyaltyProgramConfig,
  getLoyaltyProgramStats,
  lookupLoyaltyCustomer,
  creditLoyaltyDineIn,
} from '../../../api/restaurant';

interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'number';
  step: string | null;
}

const CONFIG_FIELDS: ReadonlyArray<ConfigField> = [
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

interface LoyaltyConfig {
  is_active?: boolean;
  program_name?: string;
  points_per_rupee?: number;
  first_order_multiplier?: number;
  birthday_week_multiplier?: number;
  referral_bonus_points?: number;
  min_points_to_redeem?: number;
  max_redemption_percent?: number;
  points_to_rupee_ratio?: number;
  max_redemptions_per_day?: number;
  points_expiry_days?: number;
  expiry_warning_days?: number;
  [k: string]: unknown;
}

interface LoyaltyStats {
  total_members?: number;
  total_points_issued?: number;
  total_points_redeemed?: number;
  estimated_liability_rs?: number;
  redemption_rate?: number;
}

interface LookupResult {
  customer?: { name?: string; wa_phone_masked?: string };
  balance?: number;
  total_earned?: number;
  total_redeemed?: number;
}

interface CreditResult {
  awarded: number;
  balance: number;
}

interface CreditBody {
  phone: string;
  points: number;
  description?: string;
}

type MsgState = { kind: 'ok' | 'err'; text: string } | null;

interface ProgramOverviewProps {
  stats: LoyaltyStats | null;
  loading: boolean;
  err: string | null;
  onRetry: () => void;
  onToggleActive: (next: boolean) => void;
  config: LoyaltyConfig | null;
  savingActive: boolean;
}

function ProgramOverview({ stats, loading, err, onRetry, onToggleActive, config, savingActive }: ProgramOverviewProps) {
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
          value={loading ? '—' : `₹${(stats?.estimated_liability_rs || 0).toLocaleString()}`}
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

interface ProgramSettingsProps {
  config: LoyaltyConfig | null;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  saving: boolean;
  disabled: boolean;
}

function ProgramSettings({ config, onSave, saving, disabled }: ProgramSettingsProps) {
  const [draft, setDraft] = useState<LoyaltyConfig>(() => config ? { ...config } : {});

  useEffect(() => {
    if (config) setDraft({ ...config });
  }, [config]);

  function update(key: string, raw: string) {
    setDraft((d) => ({ ...d, [key]: raw }));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
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
        {CONFIG_FIELDS.map((f) => {
          const raw = draft[f.key];
          const valueStr = raw === undefined || raw === null ? '' : String(raw);
          return (
            <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
              <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>{f.label}</span>
              <input
                type={f.type}
                step={f.step || undefined}
                value={valueStr}
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
          );
        })}
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

interface DineInEntryProps {
  onCredit: (body: CreditBody) => Promise<CreditResult>;
  disabled: boolean;
}

function DineInEntry({ onCredit, disabled }: DineInEntryProps) {
  const [phone, setPhone] = useState<string>('');
  const [points, setPoints] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<MsgState>(null);

  async function onLookup() {
    setLookupErr(null);
    setLookupResult(null);
    if (!phone.trim()) return;
    try {
      const res = (await lookupLoyaltyCustomer(phone.trim())) as LookupResult;
      setLookupResult(res);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const reason = e?.response?.data?.error || e?.message || 'Lookup failed';
      setLookupErr(reason === 'customer_not_found' ? 'No customer found with this phone' : reason);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);
    const p = Math.floor(Number(points) || 0);
    if (!phone.trim() || p <= 0) {
      setMsg({ kind: 'err', text: 'Phone and positive points are required' });
      return;
    }
    setBusy(true);
    try {
      const body: CreditBody = { phone: phone.trim(), points: p };
      if (description.trim()) body.description = description.trim();
      const res = await onCredit(body);
      setMsg({ kind: 'ok', text: `Credited ${res.awarded} points. New balance: ${res.balance}.` });
      setPoints('');
      setDescription('');
      await onLookup();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const reason = e?.response?.data?.error || e?.message || 'Credit failed';
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
          ) : lookupResult ? (
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
          ) : null}
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

export default function LoyaltyPage() {
  const { restaurant } = useRestaurant();
  const campaignsEnabled = Boolean((restaurant as { campaigns_enabled?: boolean } | null)?.campaigns_enabled);

  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [configErr, setConfigErr] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [savingActive, setSavingActive] = useState<boolean>(false);

  const [stats, setStats] = useState<LoyaltyStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState<boolean>(true);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigErr(null);
    try {
      const data = (await getLoyaltyProgramConfig()) as LoyaltyConfig | null;
      setConfig(data || null);
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      setConfigErr(e?.userMessage || e?.message || 'Could not load program settings');
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsErr(null);
    try {
      const data = (await getLoyaltyProgramStats()) as LoyaltyStats | null;
      setStats(data || null);
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      setStatsErr(e?.userMessage || e?.message || 'Could not load program stats');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadStats(); }, [loadStats]);

  async function onSaveConfig(patch: Record<string, unknown>) {
    setSaving(true);
    try {
      const next = (await updateLoyaltyProgramConfig(patch)) as LoyaltyConfig;
      setConfig(next);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const reason = e?.response?.data?.error || e?.message || 'Save failed';
      // eslint-disable-next-line no-alert
      alert(`Could not save: ${reason}`);
    } finally {
      setSaving(false);
    }
  }

  async function onToggleActive(nextActive: boolean) {
    setSavingActive(true);
    try {
      const next = (await updateLoyaltyProgramConfig({ is_active: Boolean(nextActive) })) as LoyaltyConfig;
      setConfig(next);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const reason = e?.response?.data?.error || e?.message || 'Update failed';
      // eslint-disable-next-line no-alert
      alert(`Could not update program state: ${reason}`);
    } finally {
      setSavingActive(false);
    }
  }

  async function onDineInCredit(body: CreditBody): Promise<CreditResult> {
    const res = (await creditLoyaltyDineIn({ ...body })) as CreditResult;
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
          <div className="notice-ico">✨</div>
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
