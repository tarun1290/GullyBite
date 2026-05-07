'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useToast } from '../../../components/Toast';
import {
  getCampaignTemplates,
  getCustomerSegments,
  getWallet,
  createMarketingCampaign,
  getMarketingCampaigns,
  getMarketingCampaignSummary,
  cancelMarketingCampaign,
  getUpcomingFestivals,
  getCampaignSmartSendTime,
} from '../../../api/restaurant';
import AutoJourneysSection from '../../../components/restaurant/AutoJourneysSection';

const FESTIVAL_EMOJI: Record<string, string> = {
  diwali: '🪔',
  holi: '🌈',
  navratri: '💃',
  durga_puja: '💃',
  ganesh_chaturthi: '🕉️',
  raksha_bandhan: '🎀',
  makar_sankranti: '🪁',
  baisakhi: '🌾',
  onam: '🌺',
  eid_ul_fitr: '🌙',
  eid_ul_adha: '🌙',
  christmas: '🎄',
  new_years_eve: '🎉',
  new_years_day: '✨',
  valentines_day: '❤️',
  mothers_day: '💐',
  fathers_day: '🍻',
  independence_day: '🇮🇳',
  republic_day: '🇮🇳',
  ipl_start: '🏏',
  lohri: '🔥',
};

function festivalEmoji(slug?: string): string {
  if (!slug) return '🎉';
  const base = String(slug).replace(/_(\d{4})$/, '');
  return FESTIVAL_EMOJI[base] || '🎉';
}

const SEGMENT_COPY: Record<string, string> = {
  Champion:            'Your best customers — frequent, recent, high spend. Great for new dish announcements or VIP perks.',
  Loyal:               'Consistent customers who keep coming back. Great for loyalty rewards and referral nudges.',
  'Potential Loyalist':'Recent customers trending upward. A nudge can turn them into regulars.',
  'At Risk':           "Used to order often, but haven't lately. A gentle win-back works well here.",
  Hibernating:         "Haven't ordered in a while. Try a bigger incentive or a festival message to wake them up.",
  Lost:                'Long inactive. Lowest expected response — use only for broad festival blasts.',
  'Big Spender':       'High average order value. Great for premium dish launches.',
  'New Customer':      'Just placed their first order. Perfect for a thank-you + invite-back message.',
  Other:               'Customers without enough order history to segment yet.',
};

const SEGMENT_ORDER: ReadonlyArray<string> = [
  'Champion', 'Loyal', 'Potential Loyalist', 'Big Spender', 'New Customer',
  'At Risk', 'Hibernating', 'Lost', 'Other',
];

const USE_CASE_LABELS: Record<string, string> = {
  welcome: 'Welcome',
  winback_short: 'Win-back',
  winback_long: 'Win-back',
  birthday: 'Birthday',
  loyalty_expiry: 'Loyalty',
  milestone: 'Milestone',
  manual_blast: 'Broadcast',
  festival: 'Festival',
  new_dish: 'New Dish',
  general: 'General',
};

interface StatusStyle { bg: string; fg: string; label: string }

const STATUS_STYLE: Record<string, StatusStyle> = {
  draft:     { bg: '#e5e7eb', fg: '#374151', label: 'Draft' },
  scheduled: { bg: '#dbeafe', fg: '#1e40af', label: 'Scheduled' },
  sending:   { bg: '#fef3c7', fg: '#92400e', label: 'Sending' },
  sent:      { bg: '#dcfce7', fg: '#166534', label: 'Sent' },
  failed:    { bg: '#fee2e2', fg: '#991b1b', label: 'Failed' },
  cancelled: { bg: '#e5e7eb', fg: '#6b7280', label: 'Cancelled' },
};

interface WalletData {
  campaigns_enabled?: boolean;
  balance_rs?: number | string;
}

interface SegmentRow { label: string; count?: number }

interface SegmentsResponse { segments?: SegmentRow[] }

interface TemplateVariable {
  name: string;
  source?: string;
  required?: boolean;
  default_value?: string;
  description?: string;
}

interface CampaignTemplate {
  template_id: string;
  display_name: string;
  use_case: string;
  per_message_cost_rs?: number | string;
  body_template?: string;
  preview_text?: string;
  variables?: TemplateVariable[];
}

interface CampaignStats {
  sent?: number;
  delivered?: number;
  read_rate?: number;
  conversion_rate?: number;
  revenue_attributed_rs?: number | string;
}

interface MarketingCampaign {
  id: string;
  display_name: string;
  status: string;
  target_segment: string;
  target_count?: number;
  actual_sent_count?: number;
  actual_cost_rs?: number | string;
  stats?: CampaignStats;
  created_at?: string;
  send_at?: string;
  error_message?: string;
}

interface CampaignsResponse { campaigns?: MarketingCampaign[] }

interface SummaryData {
  total_campaigns?: number;
  campaigns_this_month?: number;
  total_sent?: number;
  total_delivered?: number;
  average_read_rate?: number;
  average_conversion_rate?: number;
  total_revenue_attributed_rs?: number | string;
  total_cost_rs?: number | string;
}

interface Festival {
  slug?: string;
  name: string;
  days_until?: number | null;
  suggested_message_hint?: string;
  default_template_use_case?: string;
  already_sent?: boolean;
}

interface FestivalsResponse { festivals?: Festival[] }

interface SmartSend {
  next_occurrence: string;
  peak_hour_label: string;
  order_count_at_peak: number;
}

interface WizardPrefill {
  startStep?: number;
  displayName?: string;
  templateUseCase?: string;
}

interface CampaignPayload {
  template_id: string;
  display_name: string;
  target_segment: string | null;
  variable_values: Record<string, string>;
  send_at?: string | undefined;
}

interface StatusChipProps { status?: string }

function StatusChip({ status }: StatusChipProps) {
  const fallback: StatusStyle = { bg: '#e5e7eb', fg: '#374151', label: status || '—' };
  const s = STATUS_STYLE[status || ''] || fallback;
  return (
    // bg/fg from STATUS_STYLE map keyed by status at runtime
    <span className="chip text-[0.7rem]" style={{ background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  );
}

function SegmentBadge({ label }: { label: string }) {
  return (
    <span className="chip bg-[#eef2ff] text-[#3730a3] text-[0.7rem]">
      {label === 'all' ? 'All customers' : label}
    </span>
  );
}

function substitutePreview(body: string, resolved: Record<string, string | undefined>): string {
  if (!body) return '';
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, name: string) => {
    const v = resolved[name];
    if (v === undefined || v === null || v === '') return `{{${name}}}`;
    return String(v);
  });
}

function fmtDateTime(d?: string | null): string {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

function formatRs(v: number | string | undefined | null): string {
  return `₹${Number(v || 0).toFixed(2)}`;
}

// ───────────────────────────── Festival nudge ──────────────────────

interface FestivalNudgeBannerProps { festival: Festival; onCreate: () => void }

function FestivalNudgeBanner({ festival, onCreate }: FestivalNudgeBannerProps) {
  const emoji = festivalEmoji(festival.slug);
  const days = festival.days_until ?? 0;
  const daysLabel = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return (
    <div className="flex items-center gap-3 py-[0.85rem] px-4 mb-4 bg-[linear-gradient(135deg,#fff7ed_0%,#fef3c7_100%)] border border-[#fbbf24] rounded-r">
      <span className="text-[1.6rem]">{emoji}</span>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-[#78350f]">
          {festival.name} is {daysLabel}!
        </div>
        <div className="text-[0.82rem] text-[#92400e]">
          {festival.suggested_message_hint || 'Send a campaign to your customers.'}
        </div>
      </div>
      <button
        className="btn-p btn-sm whitespace-nowrap"
        onClick={onCreate}
      >
        Create Festival Campaign
      </button>
    </div>
  );
}

// ───────────────────────────── History list ────────────────────────

interface HistoryListProps {
  campaigns: MarketingCampaign[];
  summary: SummaryData | null;
  onCancel: (id: string) => void;
  onRefresh: () => void;
  onCreate: () => void;
  disabled: boolean;
}

function HistoryList({ campaigns, summary, onCancel, onRefresh, onCreate, disabled }: HistoryListProps) {
  return (
    <div>
      <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
        <div>
          <h2 className="m-0">Marketing Campaigns</h2>
          <div className="text-[0.84rem] text-dim mt-[0.2rem]">
            One-time blasts to a customer segment using approved templates.
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn-g btn-sm" onClick={onRefresh} disabled={disabled}>Refresh</button>
          <button className="btn-p btn-sm" onClick={onCreate} disabled={disabled}>+ Create Campaign</button>
        </div>
      </div>

      {summary && (
        <div className="grid gap-[0.6rem] grid-cols-[repeat(auto-fill,minmax(180px,1fr))] mb-4">
          <SummaryCard label="Campaigns" value={summary.total_campaigns} />
          <SummaryCard label="This month" value={summary.campaigns_this_month} />
          <SummaryCard label="Messages sent" value={summary.total_sent} />
          <SummaryCard label="Delivered" value={summary.total_delivered} />
          <SummaryCard label="Avg read rate" value={`${Number(summary.average_read_rate || 0).toFixed(1)}%`} />
          <SummaryCard label="Avg conv rate" value={`${Number(summary.average_conversion_rate || 0).toFixed(1)}%`} />
          <SummaryCard label="Revenue" value={formatRs(summary.total_revenue_attributed_rs)} />
          <SummaryCard label="Spend" value={formatRs(summary.total_cost_rs)} />
        </div>
      )}

      {campaigns.length === 0 ? (
        <div className="card">
          <div className="cb text-dim">
            No campaigns yet. Click <strong>Create Campaign</strong> to blast your first template.
          </div>
        </div>
      ) : (
        <div className="grid gap-[0.6rem]">
          {campaigns.map((c) => (
            <div key={c.id} className="card">
              <div className="cb flex flex-col gap-2">
                <div className="flex justify-between gap-2 flex-wrap">
                  <div className="flex gap-2 items-center flex-wrap">
                    <strong>{c.display_name}</strong>
                    <StatusChip status={c.status} />
                    <SegmentBadge label={c.target_segment} />
                  </div>
                  <div className="text-[0.78rem] text-dim">
                    {fmtDateTime(c.created_at)}
                  </div>
                </div>
                <div className="grid gap-[0.4rem] grid-cols-[repeat(auto-fill,minmax(120px,1fr))] text-[0.82rem]">
                  <Stat label="Target" value={c.target_count} />
                  <Stat label="Sent" value={c.actual_sent_count || c.stats?.sent || 0} />
                  <Stat label="Delivered" value={c.stats?.delivered || 0} />
                  <Stat label="Read rate" value={`${Number(c.stats?.read_rate || 0).toFixed(1)}%`} />
                  <Stat label="Conv rate" value={`${Number(c.stats?.conversion_rate || 0).toFixed(1)}%`} />
                  <Stat label="Revenue" value={formatRs(c.stats?.revenue_attributed_rs)} />
                  <Stat label="Spend" value={formatRs(c.actual_cost_rs)} />
                </div>
                {c.send_at && c.status === 'scheduled' && (
                  <div className="text-[0.82rem] text-[#1e40af]">
                    Scheduled for {fmtDateTime(c.send_at)}
                  </div>
                )}
                {c.error_message && (
                  <div className="text-[0.82rem] text-[#991b1b]">
                    Error: {c.error_message}
                  </div>
                )}
                {(c.status === 'draft' || c.status === 'scheduled') && (
                  <div>
                    <button
                      className="btn-g btn-sm"
                      onClick={() => onCancel(c.id)}
                      disabled={disabled}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SummaryCardProps { label: string; value: ReactNode }

function SummaryCard({ label, value }: SummaryCardProps) {
  return (
    <div className="card">
      <div className="cb py-[0.55rem] px-[0.7rem]">
        <div className="text-[0.72rem] text-dim uppercase tracking-[0.03em]">{label}</div>
        <div className="text-[1.1rem] font-semibold mt-[0.15rem]">{value ?? 0}</div>
      </div>
    </div>
  );
}

interface StatProps { label: string; value: ReactNode }

function Stat({ label, value }: StatProps) {
  return (
    <div>
      <div className="text-[0.7rem] text-dim">{label}</div>
      <div className="font-medium">{value ?? 0}</div>
    </div>
  );
}

// ───────────────────────────── Wizard ──────────────────────────────

type SendMode = 'now' | 'later' | 'smart';

interface WizardProps {
  segments: SegmentRow[];
  templates: CampaignTemplate[];
  walletBalance: number;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (payload: CampaignPayload) => void | Promise<void>;
  submitting: boolean;
  prefill: WizardPrefill | null;
  smartSend: SmartSend | null;
}

function Wizard({
  segments, templates, walletBalance, disabled,
  onCancel, onSubmit, submitting,
  prefill, smartSend,
}: WizardProps) {
  const [step, setStep] = useState<number>(prefill?.startStep || 1);
  const [segment, setSegment] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState<string>(prefill?.displayName || '');
  const [sendMode, setSendMode] = useState<SendMode>('now');
  const [sendAt, setSendAt] = useState<string>('');
  const [confirming, setConfirming] = useState<boolean>(false);
  const [templateFilter] = useState<string | null>(prefill?.templateUseCase || null);

  const template = useMemo<CampaignTemplate | null>(
    () => templates.find((t) => t.template_id === templateId) || null,
    [templates, templateId],
  );

  const recipientCount = useMemo<number>(() => {
    if (!segment) return 0;
    if (segment === 'all') return segments.reduce((sum, s) => sum + (s.count || 0), 0);
    const match = segments.find((s) => s.label === segment);
    return match?.count || 0;
  }, [segment, segments]);

  const perMsg = Number(template?.per_message_cost_rs || 0);
  const estimatedCost = Number((recipientCount * perMsg).toFixed(2));
  const enoughBalance = walletBalance >= estimatedCost;

  const restaurantInputVars = (template?.variables || []).filter((v) => v.source === 'restaurant_input');

  const previewResolved = useMemo<Record<string, string | undefined>>(() => {
    const out: Record<string, string | undefined> = { ...vars };
    for (const v of template?.variables || []) {
      if (v.source !== 'restaurant_input' && v.default_value) {
        out[v.name] = v.default_value;
      }
    }
    return out;
  }, [vars, template]);

  const preview = substitutePreview(template?.body_template || '', previewResolved);

  const missingVars = restaurantInputVars
    .filter((v) => v.required && !(vars[v.name] && String(vars[v.name]).trim()))
    .map((v) => v.name);

  const canAdvanceStep1 = Boolean(segment) && recipientCount > 0;
  const canAdvanceStep2 = Boolean(template) && missingVars.length === 0;
  const sendAtDate = sendAt ? new Date(sendAt) : null;
  const smartAvailable = Boolean(smartSend && smartSend.next_occurrence);
  const smartDate = smartAvailable && smartSend ? new Date(smartSend.next_occurrence) : null;
  const sendAtValid = sendMode === 'now'
    || (sendMode === 'smart' && smartAvailable)
    || (sendMode === 'later' && Boolean(sendAtDate) && !isNaN(sendAtDate!.getTime()) && sendAtDate!.getTime() > Date.now());
  const canSubmit = canAdvanceStep1 && canAdvanceStep2 && displayName.trim().length > 0 && sendAtValid && enoughBalance;

  let payloadSendAt: string | undefined;
  if (sendMode === 'later' && sendAtDate) payloadSendAt = sendAtDate.toISOString();
  else if (sendMode === 'smart' && smartDate) payloadSendAt = smartDate.toISOString();

  const payload: CampaignPayload = {
    template_id: templateId,
    display_name: displayName.trim(),
    target_segment: segment,
    variable_values: vars,
    send_at: payloadSendAt,
  };

  const visibleTemplates = templateFilter
    ? (templates.filter((t) => t.use_case === templateFilter).length
        ? templates.filter((t) => t.use_case === templateFilter)
        : templates)
    : templates;

  const submit = async () => {
    if (!canSubmit) return;
    await onSubmit(payload);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="m-0">Create Campaign</h2>
          <div className="text-[0.84rem] text-dim mt-[0.2rem]">
            Step {step} of 3 — {step === 1 ? 'Choose audience' : step === 2 ? 'Pick template' : 'Schedule & confirm'}
          </div>
        </div>
        <button className="btn-g btn-sm" onClick={onCancel}>← Back to history</button>
      </div>

      <div className="flex gap-[0.3rem] mb-4">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            // background colour conditional on whether the step is active vs inactive at runtime
            className={`flex-1 h-1 rounded-xs ${n <= step ? 'bg-[#4f46e5]' : 'bg-[#e5e7eb]'}`}
          />
        ))}
      </div>

      <div className={disabled ? 'opacity-60 pointer-events-none' : 'opacity-100 pointer-events-auto'}>
        {step === 1 && (
          <Step1Audience
            segments={segments}
            segment={segment}
            onPick={setSegment}
          />
        )}
        {step === 2 && (
          <Step2Template
            templates={visibleTemplates}
            templateId={templateId}
            onPickTemplate={setTemplateId}
            template={template}
            vars={vars}
            onVarsChange={setVars}
            preview={preview}
            restaurantInputVars={restaurantInputVars}
            recipientCount={recipientCount}
            estimatedCost={estimatedCost}
            walletBalance={walletBalance}
            enoughBalance={enoughBalance}
          />
        )}
        {step === 3 && (
          <Step3Schedule
            displayName={displayName}
            onDisplayNameChange={setDisplayName}
            sendMode={sendMode}
            onSendModeChange={setSendMode}
            sendAt={sendAt}
            onSendAtChange={setSendAt}
            sendAtValid={sendAtValid}
            segment={segment}
            recipientCount={recipientCount}
            template={template}
            estimatedCost={estimatedCost}
            walletBalance={walletBalance}
            enoughBalance={enoughBalance}
            smartSend={smartSend}
          />
        )}
      </div>

      <div className="flex justify-between mt-[1.2rem] gap-2">
        <div>
          {step > 1 && (
            <button className="btn-g" onClick={() => setStep(step - 1)} disabled={submitting}>Back</button>
          )}
        </div>
        <div className="flex gap-2">
          {step === 1 && (
            <button className="btn-p" onClick={() => setStep(2)} disabled={!canAdvanceStep1 || disabled}>
              Next: Template →
            </button>
          )}
          {step === 2 && (
            <button className="btn-p" onClick={() => setStep(3)} disabled={!canAdvanceStep2 || disabled}>
              Next: Schedule →
            </button>
          )}
          {step === 3 && !confirming && (
            <button className="btn-p" onClick={() => setConfirming(true)} disabled={!canSubmit || disabled || submitting}>
              Review & Send
            </button>
          )}
          {step === 3 && confirming && (
            <>
              <button className="btn-g" onClick={() => setConfirming(false)} disabled={submitting}>No, go back</button>
              <button className="btn-p" onClick={submit} disabled={submitting}>
                {submitting ? 'Sending…' : `Yes, ${sendMode === 'now' ? 'send now' : 'schedule'}`}
              </button>
            </>
          )}
        </div>
      </div>

      {step === 3 && confirming && (
        <div className="notice mt-[0.8rem]">
          <div className="notice-ico">⚠️</div>
          <div className="notice-body">
            <h4>Confirm campaign</h4>
            <p>
              This will {sendMode === 'now' ? 'immediately send' : 'schedule'} a message to{' '}
              <strong>{recipientCount}</strong> {segment === 'all' ? 'customers' : `${segment} customers`}.
              Estimated spend: <strong>{formatRs(estimatedCost)}</strong>. Wallet will be debited per message.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

interface Step1AudienceProps {
  segments: SegmentRow[];
  segment: string | null;
  onPick: (label: string) => void;
}

function Step1Audience({ segments, segment, onPick }: Step1AudienceProps) {
  const allCount = segments.reduce((sum, s) => sum + (s.count || 0), 0);
  const ordered = [...segments].sort(
    (a, b) => SEGMENT_ORDER.indexOf(a.label) - SEGMENT_ORDER.indexOf(b.label),
  );

  return (
    <div>
      <h3 className="text-[0.95rem] mt-0 mb-[0.6rem] mx-0">Who should receive this?</h3>
      <div className="grid gap-[0.6rem] grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
        <SegmentCard
          active={segment === 'all'}
          onClick={() => onPick('all')}
          label="All customers"
          count={allCount}
          copy="Send to every customer on file with a WhatsApp number. Use sparingly — high cost, lower relevance."
        />
        {ordered.map((s) => (
          <SegmentCard
            key={s.label}
            active={segment === s.label}
            onClick={() => onPick(s.label)}
            label={s.label}
            count={s.count}
            copy={SEGMENT_COPY[s.label] || ''}
          />
        ))}
      </div>
    </div>
  );
}

interface SegmentCardProps {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number | undefined;
  copy: string;
}

function SegmentCard({ active, onClick, label, count, copy }: SegmentCardProps) {
  const disabled = (count || 0) === 0;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`card text-left p-0 ${disabled ? 'cursor-not-allowed bg-[#f9fafb] opacity-55' : 'cursor-pointer bg-white opacity-100'} ${active ? 'border-2 border-[#4f46e5]' : 'border border-line'}`}
    >
      <div className="cb flex flex-col gap-[0.35rem]">
        <div className="flex justify-between items-center">
          <strong>{label}</strong>
          <span className={`chip text-[0.72rem] ${active ? 'bg-[#4f46e5] text-white' : 'bg-[#eef2ff] text-[#3730a3]'}`}>
            {count || 0}
          </span>
        </div>
        <div className="text-[0.78rem] text-[#475569]">{copy}</div>
      </div>
    </button>
  );
}

interface Step2TemplateProps {
  templates: CampaignTemplate[];
  templateId: string;
  onPickTemplate: (id: string) => void;
  template: CampaignTemplate | null;
  vars: Record<string, string>;
  onVarsChange: (v: Record<string, string>) => void;
  preview: string;
  restaurantInputVars: TemplateVariable[];
  recipientCount: number;
  estimatedCost: number;
  walletBalance: number;
  enoughBalance: boolean;
}

function Step2Template({
  templates, templateId, onPickTemplate, template,
  vars, onVarsChange, preview, restaurantInputVars,
  recipientCount, estimatedCost, walletBalance, enoughBalance,
}: Step2TemplateProps) {
  const grouped = useMemo<[string, CampaignTemplate[]][]>(() => {
    const map = new Map<string, CampaignTemplate[]>();
    for (const t of templates) {
      const key = USE_CASE_LABELS[t.use_case] || 'General';
      if (!map.has(key)) map.set(key, []);
      const arr = map.get(key);
      if (arr) arr.push(t);
    }
    return [...map.entries()];
  }, [templates]);

  return (
    // grid columns conditional on whether a template is selected at runtime
    <div className="grid gap-4" style={{ gridTemplateColumns: template ? '1fr 1fr' : '1fr' }}>
      <div>
        <h3 className="text-[0.95rem] mt-0 mb-[0.6rem] mx-0">Pick a template</h3>
        {grouped.length === 0 ? (
          <div className="card"><div className="cb text-dim">No approved templates available.</div></div>
        ) : grouped.map(([group, items]) => (
          <section key={group} className="mb-4">
            <h4 className="text-[0.82rem] mt-0 mb-[0.4rem] mx-0 text-[#475569]">{group}</h4>
            <div className="grid gap-2">
              {items.map((t) => (
                <button
                  type="button"
                  key={t.template_id}
                  onClick={() => onPickTemplate(t.template_id)}
                  className={`card text-left p-0 cursor-pointer ${templateId === t.template_id ? 'border-2 border-[#4f46e5]' : 'border border-line'}`}
                >
                  <div className="cb flex flex-col gap-[0.3rem]">
                    <div className="flex justify-between items-center flex-wrap gap-[0.4rem]">
                      <strong className="text-[0.9rem]">{t.display_name}</strong>
                      <span className="text-[0.74rem] text-dim">
                        {formatRs(t.per_message_cost_rs)} / msg
                      </span>
                    </div>
                    <div className="text-[0.78rem] text-[#475569] whitespace-pre-wrap">
                      {(t.preview_text || t.body_template || '').slice(0, 140)}
                      {(t.body_template || '').length > 140 ? '…' : ''}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      {template && (
        <div className="flex flex-col gap-[0.8rem]">
          {restaurantInputVars.length > 0 && (
            <div className="card">
              <div className="ch"><strong>Fill template variables</strong></div>
              <div className="cb flex flex-col gap-[0.55rem]">
                {restaurantInputVars.map((v) => (
                  <label key={v.name} className="flex flex-col gap-[0.2rem]">
                    <span className="text-[0.78rem] text-[#334155]">
                      {v.name}{v.required ? ' *' : ''}
                      {v.description ? <span className="text-dim ml-[0.3rem]">— {v.description}</span> : null}
                    </span>
                    <input
                      type="text"
                      value={vars[v.name] || ''}
                      placeholder={v.default_value || ''}
                      onChange={(e) => onVarsChange({ ...vars, [v.name]: e.target.value })}
                      className="py-[0.4rem] px-[0.55rem] border border-[#e5e7eb] rounded-md"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="ch"><strong>Preview</strong></div>
            <div className="cb">
              <div className="text-[0.82rem] text-[#334155] bg-ink3 py-[0.6rem] px-3 rounded-md whitespace-pre-wrap min-h-[80px]">
                {preview || '—'}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="cb flex flex-col gap-[0.3rem] text-[0.82rem]">
              <div className="flex justify-between">
                <span className="text-dim">Recipients</span>
                <strong>{recipientCount}</strong>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Per-message</span>
                <strong>{formatRs(template.per_message_cost_rs)}</strong>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Estimated total</span>
                <strong>{formatRs(estimatedCost)}</strong>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Wallet balance</span>
                <strong className={enoughBalance ? 'text-[#166534]' : 'text-[#991b1b]'}>
                  {formatRs(walletBalance)}
                </strong>
              </div>
              {!enoughBalance && (
                <div className="text-[#991b1b] text-[0.78rem]">
                  Wallet balance is below the estimated cost. Top up before sending.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface Step3ScheduleProps {
  displayName: string;
  onDisplayNameChange: (v: string) => void;
  sendMode: SendMode;
  onSendModeChange: (m: SendMode) => void;
  sendAt: string;
  onSendAtChange: (v: string) => void;
  sendAtValid: boolean;
  segment: string | null;
  recipientCount: number;
  template: CampaignTemplate | null;
  estimatedCost: number;
  walletBalance: number;
  enoughBalance: boolean;
  smartSend: SmartSend | null;
}

function Step3Schedule({
  displayName, onDisplayNameChange,
  sendMode, onSendModeChange,
  sendAt, onSendAtChange, sendAtValid,
  segment, recipientCount, template, estimatedCost,
  walletBalance, enoughBalance,
  smartSend,
}: Step3ScheduleProps) {
  const smartAvailable = Boolean(smartSend && smartSend.next_occurrence);
  const whenLabel = (() => {
    if (sendMode === 'now') return 'Immediately';
    if (sendMode === 'smart' && smartAvailable && smartSend) return fmtDateTime(smartSend.next_occurrence);
    if (sendMode === 'later') return sendAt ? fmtDateTime(sendAt) : 'Pick a time';
    return '—';
  })();

  return (
    <div className="grid gap-4 grid-cols-[1fr_1fr]">
      <div className="card">
        <div className="ch"><strong>Campaign name</strong></div>
        <div className="cb flex flex-col gap-[0.55rem]">
          <input
            type="text"
            placeholder="e.g. New menu launch — June"
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            className="py-2 px-[0.6rem] border border-[#e5e7eb] rounded-md"
          />
          <div className="text-[0.76rem] text-dim">
            Only shown to you in the campaign history.
          </div>
        </div>

        <div className="ch mt-2"><strong>When to send</strong></div>
        <div className="cb grid gap-2">
          <label className={`card p-0 cursor-pointer ${sendMode === 'now' ? 'border-2 border-[#4f46e5]' : 'border border-line'}`}>
            <div className="cb flex gap-2 items-start">
              <input type="radio" checked={sendMode === 'now'} onChange={() => onSendModeChange('now')} />
              <div>
                <div><strong>Send now</strong></div>
                <div className="text-[0.78rem] text-dim">
                  Start the blast immediately in the background.
                </div>
              </div>
            </div>
          </label>

          {smartAvailable && smartSend && (
            <label className={`card p-0 cursor-pointer ${sendMode === 'smart' ? 'border-2 border-[#059669] bg-[#ecfdf5]' : 'border border-line bg-white'}`}>
              <div className="cb flex gap-2 items-start">
                <input type="radio" checked={sendMode === 'smart'} onChange={() => onSendModeChange('smart')} />
                <div className="flex-1">
                  <div className="flex items-center gap-[0.4rem] flex-wrap">
                    <strong>Smart Send</strong>
                    <span className="chip bg-[#059669] text-white text-[0.65rem] py-[0.1rem] px-[0.4rem]">
                      Recommended
                    </span>
                    <span className="text-[0.76rem] text-dim">
                      Best time based on your customers
                    </span>
                  </div>
                  <div className="text-[0.78rem] text-[#065f46] mt-1">
                    We&apos;ll send at <strong>{smartSend.peak_hour_label}</strong> — when your customers are most
                    active ({smartSend.order_count_at_peak} orders typically placed around this time).
                  </div>
                  {sendMode === 'smart' && (
                    <div className="text-[0.75rem] text-dim mt-1">
                      Scheduled for {fmtDateTime(smartSend.next_occurrence)}
                    </div>
                  )}
                </div>
              </div>
            </label>
          )}

          <label className={`card p-0 cursor-pointer ${sendMode === 'later' ? 'border-2 border-[#4f46e5]' : 'border border-line'}`}>
            <div className="cb flex gap-2 items-start">
              <input type="radio" checked={sendMode === 'later'} onChange={() => onSendModeChange('later')} />
              <div className="flex-1">
                <div><strong>Schedule for later</strong></div>
                <div className="text-[0.78rem] text-dim mb-[0.4rem]">
                  Picks up on the next minute tick after the scheduled time.
                </div>
                {sendMode === 'later' && (
                  <>
                    <input
                      type="datetime-local"
                      value={sendAt}
                      onChange={(e) => onSendAtChange(e.target.value)}
                      className="py-[0.35rem] px-2 border border-[#e5e7eb] rounded-md"
                    />
                    {!sendAtValid && sendAt && (
                      <div className="text-[0.76rem] text-[#991b1b] mt-[0.3rem]">
                        Pick a time in the future.
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </label>
        </div>
      </div>

      <div className="card">
        <div className="ch"><strong>Summary</strong></div>
        <div className="cb flex flex-col gap-[0.4rem] text-[0.85rem]">
          <Row k="Audience" v={segment === 'all' ? 'All customers' : segment || '—'} />
          <Row k="Recipients" v={recipientCount} />
          <Row k="Template" v={template?.display_name || '—'} />
          <Row k="Per-message cost" v={formatRs(template?.per_message_cost_rs)} />
          <Row k="Estimated spend" v={formatRs(estimatedCost)} />
          <Row k="Wallet" v={formatRs(walletBalance)} />
          <Row k="When" v={whenLabel} />
          {!enoughBalance && (
            <div className="text-[#991b1b] text-[0.8rem] mt-[0.3rem]">
              Wallet balance is below the estimated cost.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface RowProps { k: string; v: ReactNode }

function Row({ k, v }: RowProps) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-dim">{k}</span>
      <strong>{v}</strong>
    </div>
  );
}

// ───────────────────────────── Root ────────────────────────────────

type TabKey = 'manual' | 'journeys';
type ViewKey = 'history' | 'wizard';

export default function CampaignsPage() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<TabKey>('manual');
  const [view, setView] = useState<ViewKey>('history');
  const [loading, setLoading] = useState<boolean>(true);
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [templates, setTemplates] = useState<CampaignTemplate[]>([]);
  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>([]);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [festivals, setFestivals] = useState<Festival[]>([]);
  const [smartSend, setSmartSend] = useState<SmartSend | null>(null);
  const [wizardPrefill, setWizardPrefill] = useState<WizardPrefill | null>(null);

  const campaignsEnabled = Boolean(wallet?.campaigns_enabled);
  const walletBalance = Number(wallet?.balance_rs || 0);
  const disabled = !campaignsEnabled;

  const loadAll = async () => {
    setLoading(true);
    try {
      const [tpls, segs, list, sum, w, fests, smart] = await Promise.all([
        getCampaignTemplates().catch(() => []),
        getCustomerSegments().catch(() => ({ segments: [] })),
        getMarketingCampaigns({ limit: 50 }).catch(() => ({ campaigns: [] })),
        getMarketingCampaignSummary().catch(() => null),
        getWallet().catch(() => ({})),
        getUpcomingFestivals().catch(() => ({ festivals: [] })),
        getCampaignSmartSendTime().catch(() => null),
      ]);
      setTemplates(Array.isArray(tpls) ? (tpls as CampaignTemplate[]) : []);
      const segsResp = segs as SegmentsResponse;
      setSegments(Array.isArray(segsResp?.segments) ? segsResp.segments : []);
      const listResp = list as CampaignsResponse;
      setCampaigns(Array.isArray(listResp?.campaigns) ? listResp.campaigns : []);
      setSummary(sum as SummaryData | null);
      setWallet((w as WalletData) || {});
      const festsResp = fests as FestivalsResponse;
      setFestivals(Array.isArray(festsResp?.festivals) ? festsResp.festivals : []);
      setSmartSend((smart as SmartSend | null) || null);
    } catch (err: unknown) {
      const e = err as { message?: string };
      showToast(e?.message || 'Failed to load campaigns', 'error');
    } finally {
      setLoading(false);
    }
  };

  // First festival within 14 days that hasn't already had a campaign.
  const nextFestival = useMemo<Festival | null>(() => {
    return festivals.find((f) => !f.already_sent && f.days_until != null && f.days_until <= 14) || null;
  }, [festivals]);

  const launchFromFestival = (festival: Festival) => {
    setWizardPrefill({
      startStep: 2,
      displayName: `${festival.name} Campaign`,
      templateUseCase: festival.default_template_use_case || 'festival',
    });
    setView('wizard');
  };

  const startBlankWizard = () => {
    setWizardPrefill(null);
    setView('wizard');
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancel = async (id: string) => {
    try {
      await cancelMarketingCampaign(id);
      showToast('Campaign cancelled', 'success');
      loadAll();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Cancel failed', 'error');
    }
  };

  const handleSubmit = async (payload: CampaignPayload) => {
    setSubmitting(true);
    try {
      await createMarketingCampaign(payload as unknown as Record<string, unknown>);
      showToast(payload.send_at ? 'Campaign scheduled' : 'Campaign sending now', 'success');
      setView('history');
      loadAll();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const msg = e?.response?.data?.error || e?.message || 'Create failed';
      showToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="text-dim p-4">Loading campaigns…</div>;
  }

  return (
    <div>
      <div className="flex gap-[0.4rem] mb-4 border-b border-[#e5e7eb]">
        <button
          type="button"
          onClick={() => setTab('manual')}
          className={`btn-sm bg-transparent border-none py-2 px-[0.8rem] cursor-pointer ${tab === 'manual' ? 'border-b-2 border-b-[#4f46e5] text-[#4f46e5] font-semibold' : 'border-b-2 border-b-transparent text-dim font-normal'}`}
        >
          Manual Campaigns
        </button>
        <button
          type="button"
          onClick={() => setTab('journeys')}
          className={`btn-sm bg-transparent border-none py-2 px-[0.8rem] cursor-pointer ${tab === 'journeys' ? 'border-b-2 border-b-[#4f46e5] text-[#4f46e5] font-semibold' : 'border-b-2 border-b-transparent text-dim font-normal'}`}
        >
          Auto Journeys
        </button>
      </div>

      {tab === 'journeys' ? (
        <AutoJourneysSection campaignsEnabled={campaignsEnabled} />
      ) : (
      <>
      {disabled && (
        <div className="notice wa mb-4">
          <div className="notice-ico">✨</div>
          <div className="notice-body">
            <h4>Coming Soon</h4>
            <p>
              Marketing campaigns aren&apos;t active on your account yet. You can browse the catalog,
              but creating campaigns is disabled until campaigns go live.
            </p>
          </div>
        </div>
      )}

      {view === 'history' ? (
        <>
          {!disabled && nextFestival && (
            <FestivalNudgeBanner festival={nextFestival} onCreate={() => launchFromFestival(nextFestival)} />
          )}
          <HistoryList
            campaigns={campaigns}
            summary={summary}
            onCancel={handleCancel}
            onRefresh={loadAll}
            onCreate={startBlankWizard}
            disabled={disabled}
          />
        </>
      ) : (
        <Wizard
          segments={segments}
          templates={templates}
          walletBalance={walletBalance}
          disabled={disabled}
          onCancel={() => { setWizardPrefill(null); setView('history'); }}
          onSubmit={handleSubmit}
          submitting={submitting}
          prefill={wizardPrefill}
          smartSend={smartSend}
        />
      )}
      </>
      )}
    </div>
  );
}
