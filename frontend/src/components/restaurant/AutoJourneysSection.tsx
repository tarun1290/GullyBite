'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useToast } from '../Toast';
import {
  getAutoJourneyConfig,
  updateAutoJourneyConfig,
  getAutoJourneyStats,
  getCampaignTemplates,
} from '../../api/restaurant';

// Auto journeys dashboard surface. Six journey cards, each with an
// enabled toggle and an inline Customise panel. Interactions are
// disabled until campaigns_enabled flips on the tenant wallet; the
// Loyalty Expiry card stays disabled regardless until Prompt 7 lands.

interface JourneyMeta {
  key: string;
  label: string;
  description: string;
  icon: string;
  lockedUntilLoyalty?: boolean;
}

const JOURNEY_META: ReadonlyArray<JourneyMeta> = [
  {
    key: 'welcome',
    label: 'Welcome',
    description: 'Thank new customers 2 hours after their first order',
    icon: '👋',
  },
  {
    key: 'winback_short',
    label: 'Win-back',
    description: "Re-engage customers who haven't ordered in 14 days",
    icon: '🔗',
  },
  {
    key: 'reactivation',
    label: 'Reactivation',
    description: 'Last attempt to win back customers inactive for 30 days',
    icon: '🚀',
  },
  {
    key: 'birthday',
    label: 'Birthday',
    description: "Send a special offer on your customer's birthday",
    icon: '🎂',
  },
  {
    key: 'loyalty_expiry',
    label: 'Loyalty Expiry',
    description: 'Remind customers their points are about to expire',
    icon: '⏳',
    lockedUntilLoyalty: true,
  },
  {
    key: 'milestone',
    label: 'Milestone',
    description: 'Celebrate customers on their 5th, 10th, and 25th order',
    icon: '🎉',
  },
];

interface JourneyEntry {
  enabled?: boolean;
  template_id?: string | null;
  trigger_day?: number;
  send_hour_ist?: number;
  trigger_orders?: number[] | string;
  custom_variable_values?: Record<string, string>;
}

type JourneyConfig = Record<string, JourneyEntry>;

interface JourneyStats {
  total_sent?: number;
  total_converted?: number;
  conversion_rate?: number;
  total_cost_rs?: number;
}

interface JourneyStatsResponse {
  by_journey?: Record<string, JourneyStats>;
}

interface TemplateVariable {
  name: string;
  source?: string;
  required?: boolean;
  example?: string;
  default_value?: string;
}

interface CampaignTemplate {
  template_id: string;
  display_name: string;
  use_case: string;
  variables?: TemplateVariable[];
}

interface ToggleProps {
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}

function Toggle({ checked, disabled, onChange }: ToggleProps) {
  return (
    <label
      className={`inline-flex items-center ${disabled ? 'cursor-not-allowed opacity-[0.55]' : 'cursor-pointer opacity-100'}`}
    >
      <span
        className={`w-9 h-5 rounded-xl relative transition-[background] duration-120 ${
          checked ? 'bg-[#4f46e5]' : 'bg-[#cbd5e1]'
        }`}
      >
        <span
          className="absolute top-[2px] w-4 h-4 rounded-full bg-white transition-[left] duration-120"
          // left position is the toggle thumb's slide animation — runtime
          // boolean → 18px (on) or 2px (off).
          style={{ left: checked ? 18 : 2 }}
        />
      </span>
      <input
        type="checkbox" checked={checked} disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        className="hidden"
      />
    </label>
  );
}

interface StatProps { label: string; value: ReactNode }

function Stat({ label, value }: StatProps) {
  return (
    <div>
      <div className="text-[0.7rem] text-dim">{label}</div>
      <div className="font-medium text-[0.92rem]">{value ?? '—'}</div>
    </div>
  );
}

interface FieldProps { label: string; children: ReactNode; hint?: string }

function Field({ label, children, hint }: FieldProps) {
  return (
    <label className="flex flex-col gap-[0.2rem]">
      <span className="text-[0.78rem] text-[#334155]">{label}</span>
      {children}
      {hint && <span className="text-[0.72rem] text-dim">{hint}</span>}
    </label>
  );
}

interface JourneyCardProps {
  meta: JourneyMeta;
  config: JourneyConfig;
  stats?: JourneyStats | undefined;
  templates: CampaignTemplate[];
  onSave: (key: string, patch: JourneyEntry) => void;
  savingKey: string | null;
  disabled: boolean;
  showStats: boolean;
}

function JourneyCard({
  meta, config, stats, templates, onSave, savingKey, disabled, showStats,
}: JourneyCardProps) {
  const [expanded, setExpanded] = useState<boolean>(false);
  const key = meta.key;
  const entry = config[key] || {};
  const [local, setLocal] = useState<JourneyEntry>(() => ({ ...entry }));

  useEffect(() => { setLocal({ ...entry }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [JSON.stringify(entry)]);

  const matchingTemplates = useMemo(
    () => (templates || []).filter((t) => t.use_case === key),
    [templates, key],
  );

  const saving = savingKey === key;
  // Loyalty is ALWAYS locked until Prompt 7; otherwise follow disabled.
  const toggleDisabled = disabled || meta.lockedUntilLoyalty || false;
  const customiseDisabled = disabled || meta.lockedUntilLoyalty || false;

  const updateLocal = (patch: Partial<JourneyEntry>) => setLocal((prev) => ({ ...prev, ...patch }));

  const persistToggle = (enabled: boolean) => {
    onSave(key, { enabled });
  };

  const persistCustomise = () => {
    const payload: JourneyEntry = { ...local };
    // Normalise trigger_orders from comma string → int array if needed.
    if (key === 'milestone' && typeof payload.trigger_orders === 'string') {
      payload.trigger_orders = payload.trigger_orders
        .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    }
    onSave(key, payload);
  };

  return (
    <div className="card">
      <div className="cb flex flex-col gap-[0.55rem]">
        <div className="flex justify-between gap-2 items-start flex-wrap">
          <div className="flex gap-2 items-start flex-1 min-w-0">
            <div className="text-[1.2rem]">{meta.icon}</div>
            <div>
              <strong>{meta.label}</strong>
              <div className="text-[0.78rem] text-dim">{meta.description}</div>
            </div>
          </div>
          <Toggle
            checked={Boolean(entry.enabled)}
            disabled={toggleDisabled || saving}
            onChange={persistToggle}
          />
        </div>

        {meta.lockedUntilLoyalty && (
          <div className="notice m-0">
            <div className="notice-ico">📍</div>
            <div className="notice-body">
              <p className="m-0 text-[0.78rem]">
                Activates automatically when the Loyalty program is set up.
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-[0.4rem] grid-cols-[repeat(auto-fill,minmax(120px,1fr))] text-[0.82rem]">
          <Stat label="Sent (30d)"  value={showStats ? (stats?.total_sent ?? 0) : '—'} />
          <Stat label="Converted"   value={showStats ? (stats?.total_converted ?? 0) : '—'} />
          <Stat label="Conv rate"   value={showStats ? `${Number(stats?.conversion_rate || 0).toFixed(1)}%` : '—'} />
          <Stat label="Spend (30d)" value={showStats ? `₹${Number(stats?.total_cost_rs || 0).toFixed(2)}` : '—'} />
        </div>

        <button
          className="btn-g btn-sm self-start"
          onClick={() => setExpanded((v) => !v)}
          disabled={customiseDisabled}
        >
          {expanded ? 'Hide customise' : 'Customise'}
        </button>

        {expanded && !customiseDisabled && (
          <div className="flex flex-col gap-[0.55rem] mt-1">
            <Field label="Template">
              <select
                value={local.template_id || ''}
                onChange={(e) => updateLocal({ template_id: e.target.value || null })}
                className="py-[0.35rem] px-2 border border-[#e5e7eb] rounded-md"
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
                  className="py-[0.35rem] px-2 border border-[#e5e7eb] rounded-md w-[120px]"
                />
              </Field>
            )}

            {key === 'birthday' && (
              <Field label="Send hour (IST, 0-23)">
                <input
                  type="number" min={0} max={23}
                  value={local.send_hour_ist ?? 10}
                  onChange={(e) => updateLocal({ send_hour_ist: Number(e.target.value) })}
                  className="py-[0.35rem] px-2 border border-[#e5e7eb] rounded-md w-[120px]"
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
                  className="py-[0.35rem] px-2 border border-[#e5e7eb] rounded-md"
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

interface TemplateVarOverridesProps {
  template?: CampaignTemplate | undefined;
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}

function TemplateVarOverrides({ template, values, onChange }: TemplateVarOverridesProps) {
  const inputs = (template?.variables || []).filter((v) => v.source === 'restaurant_input');
  if (!template || inputs.length === 0) return null;
  return (
    <div className="flex flex-col gap-[0.35rem] pt-[0.3rem]">
      <div className="text-[0.78rem] text-[#334155]">Template variables</div>
      {inputs.map((v) => (
        <Field key={v.name} label={`${v.name}${v.required ? ' *' : ''}`}>
          <input
            type="text"
            placeholder={v.example || ''}
            value={values[v.name] || ''}
            onChange={(e) => onChange({ ...values, [v.name]: e.target.value })}
            className="py-[0.35rem] px-2 border border-[#e5e7eb] rounded-md"
          />
        </Field>
      ))}
    </div>
  );
}

interface AutoJourneysSectionProps {
  campaignsEnabled?: boolean;
}

export default function AutoJourneysSection({ campaignsEnabled }: AutoJourneysSectionProps) {
  const { showToast } = useToast();
  const [config, setConfig] = useState<JourneyConfig | null>(null);
  const [stats, setStats] = useState<JourneyStatsResponse>({ by_journey: {} });
  const [templates, setTemplates] = useState<CampaignTemplate[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [cfg, st, tpls] = await Promise.all([
        getAutoJourneyConfig().catch(() => null),
        getAutoJourneyStats().catch(() => ({ by_journey: {} })),
        getCampaignTemplates().catch(() => []),
      ]);
      setConfig(cfg as JourneyConfig | null);
      setStats((st as JourneyStatsResponse) || { by_journey: {} });
      setTemplates(Array.isArray(tpls) ? (tpls as CampaignTemplate[]) : []);
    } catch (err: unknown) {
      const e = err as { message?: string };
      showToast(e?.message || 'Failed to load journeys', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = async (key: string, patch: JourneyEntry) => {
    setSavingKey(key);
    try {
      const updated = (await updateAutoJourneyConfig({ [key]: patch })) as JourneyConfig;
      setConfig(updated);
      showToast('Saved', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const msg = e?.response?.data?.error || e?.message || 'Save failed';
      showToast(msg, 'error');
    } finally {
      setSavingKey(null);
    }
  };

  if (loading || !config) {
    return <div className="text-dim p-4">Loading auto journeys…</div>;
  }

  const disabled = !campaignsEnabled;

  return (
    <div>
      <div className="mb-4">
        <h2 className="m-0">Auto Journeys</h2>
        <div className="text-[0.84rem] text-dim mt-[0.2rem]">
          Set-and-forget messages triggered by customer behaviour.
        </div>
      </div>

      {disabled && (
        <div className="notice wa mb-4">
          <div className="notice-ico">✨</div>
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
        className={`grid gap-[0.8rem] grid-cols-[repeat(auto-fill,minmax(320px,1fr))] ${disabled ? 'opacity-75' : 'opacity-100'}`}
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
