import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
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
} from '../../api/restaurant.js';
import AutoJourneysSection from './AutoJourneysSection.jsx';

// Emoji hint per festival slug — falls back to a generic fireworks
// icon if we don't have a mapping. Kept tiny; admin can still rename
// festivals freely without breaking this.
const FESTIVAL_EMOJI = {
  diwali: '\uD83E\uDE94',
  holi: '\uD83C\uDF08',
  navratri: '\uD83D\uDC83',
  durga_puja: '\uD83D\uDC83',
  ganesh_chaturthi: '\uD83D\uDD49\uFE0F',
  raksha_bandhan: '\uD83C\uDF80',
  makar_sankranti: '\uD83E\uDE81',
  baisakhi: '\uD83C\uDF3E',
  onam: '\uD83C\uDF3A',
  eid_ul_fitr: '\uD83C\uDF19',
  eid_ul_adha: '\uD83C\uDF19',
  christmas: '\uD83C\uDF84',
  new_years_eve: '\uD83C\uDF89',
  new_years_day: '\u2728',
  valentines_day: '\u2764\uFE0F',
  mothers_day: '\uD83D\uDC90',
  fathers_day: '\uD83C\uDF7B',
  independence_day: '\uD83C\uDDEE\uD83C\uDDF3',
  republic_day: '\uD83C\uDDEE\uD83C\uDDF3',
  ipl_start: '\uD83C\uDFCF',
  lohri: '\uD83D\uDD25',
};

function festivalEmoji(slug) {
  if (!slug) return '\uD83C\uDF89';
  // Strip trailing _YYYY so "diwali_2026" → "diwali".
  const base = String(slug).replace(/_(\d{4})$/, '');
  return FESTIVAL_EMOJI[base] || '\uD83C\uDF89';
}

// Manual-blast campaign surface. Two views — history (default) and a
// 3-step wizard (audience → template → schedule). All interactive bits
// stay disabled until campaigns_enabled flips on the tenant wallet.

const SEGMENT_COPY = {
  Champion:            'Your best customers — frequent, recent, high spend. Great for new dish announcements or VIP perks.',
  Loyal:               'Consistent customers who keep coming back. Great for loyalty rewards and referral nudges.',
  'Potential Loyalist':'Recent customers trending upward. A nudge can turn them into regulars.',
  'At Risk':           "Used to order often, but haven't lately. A gentle win-back works well here.",
  Hibernating:         'Haven\u2019t ordered in a while. Try a bigger incentive or a festival message to wake them up.',
  Lost:                "Long inactive. Lowest expected response — use only for broad festival blasts.",
  'Big Spender':       'High average order value. Great for premium dish launches.',
  'New Customer':      'Just placed their first order. Perfect for a thank-you + invite-back message.',
  Other:               'Customers without enough order history to segment yet.',
};

const SEGMENT_ORDER = [
  'Champion', 'Loyal', 'Potential Loyalist', 'Big Spender', 'New Customer',
  'At Risk', 'Hibernating', 'Lost', 'Other',
];

const USE_CASE_LABELS = {
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

const STATUS_STYLE = {
  draft:     { bg: '#e5e7eb', fg: '#374151', label: 'Draft' },
  scheduled: { bg: '#dbeafe', fg: '#1e40af', label: 'Scheduled' },
  sending:   { bg: '#fef3c7', fg: '#92400e', label: 'Sending' },
  sent:      { bg: '#dcfce7', fg: '#166534', label: 'Sent' },
  failed:    { bg: '#fee2e2', fg: '#991b1b', label: 'Failed' },
  cancelled: { bg: '#e5e7eb', fg: '#6b7280', label: 'Cancelled' },
};

function StatusChip({ status }) {
  const s = STATUS_STYLE[status] || { bg: '#e5e7eb', fg: '#374151', label: status || '—' };
  return (
    <span className="chip" style={{ background: s.bg, color: s.fg, fontSize: '.7rem' }}>
      {s.label}
    </span>
  );
}

function SegmentBadge({ label }) {
  return (
    <span className="chip" style={{ background: '#eef2ff', color: '#3730a3', fontSize: '.7rem' }}>
      {label === 'all' ? 'All customers' : label}
    </span>
  );
}

function substitutePreview(body, resolved) {
  if (!body) return '';
  return body.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (m, name) => {
    const v = resolved[name];
    if (v === undefined || v === null || v === '') return `{{${name}}}`;
    return String(v);
  });
}

function fmtDateTime(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

function formatRs(v) {
  return `\u20B9${Number(v || 0).toFixed(2)}`;
}

// ───────────────────────────── Festival nudge ──────────────────────

function FestivalNudgeBanner({ festival, onCreate }) {
  const emoji = festivalEmoji(festival.slug);
  const days = festival.days_until;
  const daysLabel = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '.75rem',
      padding: '.85rem 1rem', marginBottom: '1rem',
      background: 'linear-gradient(135deg, #fff7ed 0%, #fef3c7 100%)',
      border: '1px solid #fbbf24',
      borderRadius: 'var(--r, 8px)',
    }}>
      <span style={{ fontSize: '1.6rem' }}>{emoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: '#78350f' }}>
          {festival.name} is {daysLabel}!
        </div>
        <div style={{ fontSize: '.82rem', color: '#92400e' }}>
          {festival.suggested_message_hint || 'Send a campaign to your customers.'}
        </div>
      </div>
      <button
        className="btn-p btn-sm"
        onClick={onCreate}
        style={{ whiteSpace: 'nowrap' }}
      >
        Create Festival Campaign
      </button>
    </div>
  );
}

// ───────────────────────────── History list ────────────────────────

function HistoryList({ campaigns, summary, onCancel, onRefresh, onCreate, disabled }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '.5rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>Marketing Campaigns</h2>
          <div style={{ fontSize: '.84rem', color: 'var(--dim)', marginTop: '.2rem' }}>
            One-time blasts to a customer segment using approved templates.
          </div>
        </div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <button className="btn-g btn-sm" onClick={onRefresh} disabled={disabled}>Refresh</button>
          <button className="btn-p btn-sm" onClick={onCreate} disabled={disabled}>+ Create Campaign</button>
        </div>
      </div>

      {summary && (
        <div style={{
          display: 'grid', gap: '.6rem',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          marginBottom: '1rem',
        }}>
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
          <div className="cb" style={{ color: 'var(--dim)' }}>
            No campaigns yet. Click <strong>Create Campaign</strong> to blast your first template.
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '.6rem' }}>
          {campaigns.map((c) => (
            <div key={c.id} className="card">
              <div className="cb" style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.5rem', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{c.display_name}</strong>
                    <StatusChip status={c.status} />
                    <SegmentBadge label={c.target_segment} />
                  </div>
                  <div style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
                    {fmtDateTime(c.created_at)}
                  </div>
                </div>
                <div style={{
                  display: 'grid', gap: '.4rem',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                  fontSize: '.82rem',
                }}>
                  <Stat label="Target" value={c.target_count} />
                  <Stat label="Sent" value={c.actual_sent_count || c.stats?.sent || 0} />
                  <Stat label="Delivered" value={c.stats?.delivered || 0} />
                  <Stat label="Read rate" value={`${Number(c.stats?.read_rate || 0).toFixed(1)}%`} />
                  <Stat label="Conv rate" value={`${Number(c.stats?.conversion_rate || 0).toFixed(1)}%`} />
                  <Stat label="Revenue" value={formatRs(c.stats?.revenue_attributed_rs)} />
                  <Stat label="Spend" value={formatRs(c.actual_cost_rs)} />
                </div>
                {c.send_at && c.status === 'scheduled' && (
                  <div style={{ fontSize: '.82rem', color: '#1e40af' }}>
                    Scheduled for {fmtDateTime(c.send_at)}
                  </div>
                )}
                {c.error_message && (
                  <div style={{ fontSize: '.82rem', color: '#991b1b' }}>
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

function SummaryCard({ label, value }) {
  return (
    <div className="card">
      <div className="cb" style={{ padding: '.55rem .7rem' }}>
        <div style={{ fontSize: '.72rem', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}</div>
        <div style={{ fontSize: '1.1rem', fontWeight: 600, marginTop: '.15rem' }}>{value ?? 0}</div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: '.7rem', color: 'var(--dim)' }}>{label}</div>
      <div style={{ fontWeight: 500 }}>{value ?? 0}</div>
    </div>
  );
}

// ───────────────────────────── Wizard ──────────────────────────────

function Wizard({
  segments, templates, walletBalance, disabled,
  onCancel, onSubmit, submitting,
  prefill, smartSend,
}) {
  const [step, setStep] = useState(prefill?.startStep || 1);
  const [segment, setSegment] = useState(null);     // rfm label or 'all'
  const [templateId, setTemplateId] = useState('');
  const [vars, setVars] = useState({});
  const [displayName, setDisplayName] = useState(prefill?.displayName || '');
  const [sendMode, setSendMode] = useState('now'); // 'now' | 'later' | 'smart'
  const [sendAt, setSendAt] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [templateFilter] = useState(prefill?.templateUseCase || null);

  const template = useMemo(
    () => templates.find((t) => t.template_id === templateId) || null,
    [templates, templateId],
  );

  const recipientCount = useMemo(() => {
    if (!segment) return 0;
    if (segment === 'all') return segments.reduce((sum, s) => sum + (s.count || 0), 0);
    const match = segments.find((s) => s.label === segment);
    return match?.count || 0;
  }, [segment, segments]);

  const perMsg = Number(template?.per_message_cost_rs || 0);
  const estimatedCost = Number((recipientCount * perMsg).toFixed(2));
  const enoughBalance = walletBalance >= estimatedCost;

  const restaurantInputVars = (template?.variables || []).filter((v) => v.source === 'restaurant_input');

  // Preview resolves restaurant_input vars only; other sources are substituted at send time.
  const previewResolved = useMemo(() => {
    const out = { ...vars };
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

  const canAdvanceStep1 = !!segment && recipientCount > 0;
  const canAdvanceStep2 = !!template && missingVars.length === 0;
  const sendAtDate = sendAt ? new Date(sendAt) : null;
  const smartAvailable = !!(smartSend && smartSend.next_occurrence);
  const smartDate = smartAvailable ? new Date(smartSend.next_occurrence) : null;
  const sendAtValid = sendMode === 'now'
    || (sendMode === 'smart' && smartAvailable)
    || (sendMode === 'later' && sendAtDate && !isNaN(sendAtDate.getTime()) && sendAtDate.getTime() > Date.now());
  const canSubmit = canAdvanceStep1 && canAdvanceStep2 && displayName.trim() && sendAtValid && enoughBalance;

  let payloadSendAt;
  if (sendMode === 'later' && sendAtDate) payloadSendAt = sendAtDate.toISOString();
  else if (sendMode === 'smart' && smartDate) payloadSendAt = smartDate.toISOString();

  const payload = {
    template_id: templateId,
    display_name: displayName.trim(),
    target_segment: segment,
    variable_values: vars,
    send_at: payloadSendAt,
  };

  // When the festival banner pre-fills a template use_case, show only
  // those templates in Step 2. Still pass the full list if nothing
  // matches so the user isn't stuck on an empty picker.
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '.5rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>Create Campaign</h2>
          <div style={{ fontSize: '.84rem', color: 'var(--dim)', marginTop: '.2rem' }}>
            Step {step} of 3 — {step === 1 ? 'Choose audience' : step === 2 ? 'Pick template' : 'Schedule & confirm'}
          </div>
        </div>
        <button className="btn-g btn-sm" onClick={onCancel}>\u2190 Back to history</button>
      </div>

      <div style={{ display: 'flex', gap: '.3rem', marginBottom: '1rem' }}>
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            style={{
              flex: 1, height: 4, borderRadius: 2,
              background: n <= step ? '#4f46e5' : '#e5e7eb',
            }}
          />
        ))}
      </div>

      <div style={{ opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
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

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1.2rem', gap: '.5rem' }}>
        <div>
          {step > 1 && (
            <button className="btn-g" onClick={() => setStep(step - 1)} disabled={submitting}>Back</button>
          )}
        </div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          {step === 1 && (
            <button className="btn-p" onClick={() => setStep(2)} disabled={!canAdvanceStep1 || disabled}>
              Next: Template \u2192
            </button>
          )}
          {step === 2 && (
            <button className="btn-p" onClick={() => setStep(3)} disabled={!canAdvanceStep2 || disabled}>
              Next: Schedule \u2192
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
        <div className="notice" style={{ marginTop: '.8rem' }}>
          <div className="notice-ico">\u26A0\uFE0F</div>
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

function Step1Audience({ segments, segment, onPick }) {
  const allCount = segments.reduce((sum, s) => sum + (s.count || 0), 0);
  const ordered = [...segments].sort(
    (a, b) => SEGMENT_ORDER.indexOf(a.label) - SEGMENT_ORDER.indexOf(b.label),
  );

  return (
    <div>
      <h3 style={{ fontSize: '.95rem', margin: '0 0 .6rem 0' }}>Who should receive this?</h3>
      <div style={{
        display: 'grid', gap: '.6rem',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
      }}>
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

function SegmentCard({ active, onClick, label, count, copy }) {
  const disabled = (count || 0) === 0;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className="card"
      style={{
        textAlign: 'left', padding: 0, cursor: disabled ? 'not-allowed' : 'pointer',
        border: active ? '2px solid #4f46e5' : '1px solid var(--line, #e5e7eb)',
        background: disabled ? '#f9fafb' : 'white',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <div className="cb" style={{ display: 'flex', flexDirection: 'column', gap: '.35rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{label}</strong>
          <span className="chip" style={{ background: active ? '#4f46e5' : '#eef2ff', color: active ? 'white' : '#3730a3', fontSize: '.72rem' }}>
            {count || 0}
          </span>
        </div>
        <div style={{ fontSize: '.78rem', color: '#475569' }}>{copy}</div>
      </div>
    </button>
  );
}

function Step2Template({
  templates, templateId, onPickTemplate, template,
  vars, onVarsChange, preview, restaurantInputVars,
  recipientCount, estimatedCost, walletBalance, enoughBalance,
}) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const t of templates) {
      const key = USE_CASE_LABELS[t.use_case] || 'General';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(t);
    }
    return [...map.entries()];
  }, [templates]);

  return (
    <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: template ? '1fr 1fr' : '1fr' }}>
      <div>
        <h3 style={{ fontSize: '.95rem', margin: '0 0 .6rem 0' }}>Pick a template</h3>
        {grouped.length === 0 ? (
          <div className="card"><div className="cb" style={{ color: 'var(--dim)' }}>No approved templates available.</div></div>
        ) : grouped.map(([group, items]) => (
          <section key={group} style={{ marginBottom: '1rem' }}>
            <h4 style={{ fontSize: '.82rem', margin: '0 0 .4rem 0', color: '#475569' }}>{group}</h4>
            <div style={{ display: 'grid', gap: '.5rem' }}>
              {items.map((t) => (
                <button
                  type="button"
                  key={t.template_id}
                  onClick={() => onPickTemplate(t.template_id)}
                  className="card"
                  style={{
                    textAlign: 'left', padding: 0, cursor: 'pointer',
                    border: templateId === t.template_id ? '2px solid #4f46e5' : '1px solid var(--line, #e5e7eb)',
                  }}
                >
                  <div className="cb" style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.4rem' }}>
                      <strong style={{ fontSize: '.9rem' }}>{t.display_name}</strong>
                      <span style={{ fontSize: '.74rem', color: 'var(--dim)' }}>
                        {formatRs(t.per_message_cost_rs)} / msg
                      </span>
                    </div>
                    <div style={{ fontSize: '.78rem', color: '#475569', whiteSpace: 'pre-wrap' }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
          {restaurantInputVars.length > 0 && (
            <div className="card">
              <div className="ch"><strong>Fill template variables</strong></div>
              <div className="cb" style={{ display: 'flex', flexDirection: 'column', gap: '.55rem' }}>
                {restaurantInputVars.map((v) => (
                  <label key={v.name} style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
                    <span style={{ fontSize: '.78rem', color: '#334155' }}>
                      {v.name}{v.required ? ' *' : ''}
                      {v.description ? <span style={{ color: 'var(--dim)', marginLeft: '.3rem' }}>— {v.description}</span> : null}
                    </span>
                    <input
                      type="text"
                      value={vars[v.name] || ''}
                      placeholder={v.default_value || ''}
                      onChange={(e) => onVarsChange({ ...vars, [v.name]: e.target.value })}
                      style={{ padding: '.4rem .55rem', border: '1px solid #e5e7eb', borderRadius: 6 }}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="ch"><strong>Preview</strong></div>
            <div className="cb">
              <div style={{
                fontSize: '.82rem', color: '#334155',
                background: 'var(--ink3,#f4f4f5)', padding: '.6rem .75rem',
                borderRadius: 6, whiteSpace: 'pre-wrap', minHeight: 80,
              }}>
                {preview || '—'}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="cb" style={{ display: 'flex', flexDirection: 'column', gap: '.3rem', fontSize: '.82rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--dim)' }}>Recipients</span>
                <strong>{recipientCount}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--dim)' }}>Per-message</span>
                <strong>{formatRs(template.per_message_cost_rs)}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--dim)' }}>Estimated total</span>
                <strong>{formatRs(estimatedCost)}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--dim)' }}>Wallet balance</span>
                <strong style={{ color: enoughBalance ? '#166534' : '#991b1b' }}>
                  {formatRs(walletBalance)}
                </strong>
              </div>
              {!enoughBalance && (
                <div style={{ color: '#991b1b', fontSize: '.78rem' }}>
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

function Step3Schedule({
  displayName, onDisplayNameChange,
  sendMode, onSendModeChange,
  sendAt, onSendAtChange, sendAtValid,
  segment, recipientCount, template, estimatedCost,
  walletBalance, enoughBalance,
  smartSend,
}) {
  const smartAvailable = !!(smartSend && smartSend.next_occurrence);
  const whenLabel = (() => {
    if (sendMode === 'now') return 'Immediately';
    if (sendMode === 'smart' && smartAvailable) return fmtDateTime(smartSend.next_occurrence);
    if (sendMode === 'later') return sendAt ? fmtDateTime(sendAt) : 'Pick a time';
    return '—';
  })();

  return (
    <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: '1fr 1fr' }}>
      <div className="card">
        <div className="ch"><strong>Campaign name</strong></div>
        <div className="cb" style={{ display: 'flex', flexDirection: 'column', gap: '.55rem' }}>
          <input
            type="text"
            placeholder="e.g. New menu launch — June"
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            style={{ padding: '.5rem .6rem', border: '1px solid #e5e7eb', borderRadius: 6 }}
          />
          <div style={{ fontSize: '.76rem', color: 'var(--dim)' }}>
            Only shown to you in the campaign history.
          </div>
        </div>

        <div className="ch" style={{ marginTop: '.5rem' }}><strong>When to send</strong></div>
        <div className="cb" style={{ display: 'grid', gap: '.5rem' }}>
          <label className="card" style={{
            padding: 0, cursor: 'pointer',
            border: sendMode === 'now' ? '2px solid #4f46e5' : '1px solid var(--line, #e5e7eb)',
          }}>
            <div className="cb" style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start' }}>
              <input type="radio" checked={sendMode === 'now'} onChange={() => onSendModeChange('now')} />
              <div>
                <div><strong>Send now</strong></div>
                <div style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
                  Start the blast immediately in the background.
                </div>
              </div>
            </div>
          </label>

          {smartAvailable && (
            <label className="card" style={{
              padding: 0, cursor: 'pointer',
              border: sendMode === 'smart' ? '2px solid #059669' : '1px solid var(--line, #e5e7eb)',
              background: sendMode === 'smart' ? '#ecfdf5' : '#fff',
            }}>
              <div className="cb" style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start' }}>
                <input type="radio" checked={sendMode === 'smart'} onChange={() => onSendModeChange('smart')} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem', flexWrap: 'wrap' }}>
                    <strong>Smart Send</strong>
                    <span className="chip" style={{ background: '#059669', color: '#fff', fontSize: '.65rem', padding: '.1rem .4rem' }}>
                      Recommended
                    </span>
                    <span style={{ fontSize: '.76rem', color: 'var(--dim)' }}>
                      Best time based on your customers
                    </span>
                  </div>
                  <div style={{ fontSize: '.78rem', color: '#065f46', marginTop: '.25rem' }}>
                    We'll send at <strong>{smartSend.peak_hour_label}</strong> — when your customers are most
                    active ({smartSend.order_count_at_peak} orders typically placed around this time).
                  </div>
                  {sendMode === 'smart' && (
                    <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginTop: '.25rem' }}>
                      Scheduled for {fmtDateTime(smartSend.next_occurrence)}
                    </div>
                  )}
                </div>
              </div>
            </label>
          )}

          <label className="card" style={{
            padding: 0, cursor: 'pointer',
            border: sendMode === 'later' ? '2px solid #4f46e5' : '1px solid var(--line, #e5e7eb)',
          }}>
            <div className="cb" style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start' }}>
              <input type="radio" checked={sendMode === 'later'} onChange={() => onSendModeChange('later')} />
              <div style={{ flex: 1 }}>
                <div><strong>Schedule for later</strong></div>
                <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginBottom: '.4rem' }}>
                  Picks up on the next minute tick after the scheduled time.
                </div>
                {sendMode === 'later' && (
                  <>
                    <input
                      type="datetime-local"
                      value={sendAt}
                      onChange={(e) => onSendAtChange(e.target.value)}
                      style={{ padding: '.35rem .5rem', border: '1px solid #e5e7eb', borderRadius: 6 }}
                    />
                    {!sendAtValid && sendAt && (
                      <div style={{ fontSize: '.76rem', color: '#991b1b', marginTop: '.3rem' }}>
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
        <div className="cb" style={{ display: 'flex', flexDirection: 'column', gap: '.4rem', fontSize: '.85rem' }}>
          <Row k="Audience" v={segment === 'all' ? 'All customers' : segment || '—'} />
          <Row k="Recipients" v={recipientCount} />
          <Row k="Template" v={template?.display_name || '—'} />
          <Row k="Per-message cost" v={formatRs(template?.per_message_cost_rs)} />
          <Row k="Estimated spend" v={formatRs(estimatedCost)} />
          <Row k="Wallet" v={formatRs(walletBalance)} />
          <Row k="When" v={whenLabel} />
          {!enoughBalance && (
            <div style={{ color: '#991b1b', fontSize: '.8rem', marginTop: '.3rem' }}>
              Wallet balance is below the estimated cost.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.5rem' }}>
      <span style={{ color: 'var(--dim)' }}>{k}</span>
      <strong>{v}</strong>
    </div>
  );
}

// ───────────────────────────── Root ────────────────────────────────

export default function CampaignsTab() {
  const { showToast } = useToast();
  const [tab, setTab] = useState('manual'); // 'manual' | 'journeys'
  const [view, setView] = useState('history'); // 'history' | 'wizard'
  const [loading, setLoading] = useState(true);
  const [wallet, setWallet] = useState(null);
  const [segments, setSegments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [summary, setSummary] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [festivals, setFestivals] = useState([]);
  const [smartSend, setSmartSend] = useState(null);
  const [wizardPrefill, setWizardPrefill] = useState(null);

  const campaignsEnabled = !!wallet?.campaigns_enabled;
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
      setTemplates(Array.isArray(tpls) ? tpls : []);
      setSegments(Array.isArray(segs?.segments) ? segs.segments : []);
      setCampaigns(Array.isArray(list?.campaigns) ? list.campaigns : []);
      setSummary(sum);
      setWallet(w || {});
      setFestivals(Array.isArray(fests?.festivals) ? fests.festivals : []);
      setSmartSend(smart || null);
    } catch (err) {
      showToast(err?.message || 'Failed to load campaigns', 'error');
    } finally {
      setLoading(false);
    }
  };

  // First festival within 14 days that hasn't already had a campaign.
  const nextFestival = useMemo(() => {
    return festivals.find((f) => !f.already_sent && f.days_until != null && f.days_until <= 14) || null;
  }, [festivals]);

  const launchFromFestival = (festival) => {
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

  const handleCancel = async (id) => {
    try {
      await cancelMarketingCampaign(id);
      showToast('Campaign cancelled', 'success');
      loadAll();
    } catch (err) {
      showToast(err?.response?.data?.error || err?.message || 'Cancel failed', 'error');
    }
  };

  const handleSubmit = async (payload) => {
    setSubmitting(true);
    try {
      await createMarketingCampaign(payload);
      showToast(payload.send_at ? 'Campaign scheduled' : 'Campaign sending now', 'success');
      setView('history');
      loadAll();
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Create failed';
      showToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ color: 'var(--dim)', padding: '1rem' }}>Loading campaigns…</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '.4rem', marginBottom: '1rem', borderBottom: '1px solid #e5e7eb' }}>
        <button
          type="button"
          onClick={() => setTab('manual')}
          className="btn-sm"
          style={{
            background: 'transparent', border: 'none',
            padding: '.5rem .8rem', cursor: 'pointer',
            borderBottom: tab === 'manual' ? '2px solid #4f46e5' : '2px solid transparent',
            color: tab === 'manual' ? '#4f46e5' : 'var(--dim)',
            fontWeight: tab === 'manual' ? 600 : 400,
          }}
        >
          Manual Campaigns
        </button>
        <button
          type="button"
          onClick={() => setTab('journeys')}
          className="btn-sm"
          style={{
            background: 'transparent', border: 'none',
            padding: '.5rem .8rem', cursor: 'pointer',
            borderBottom: tab === 'journeys' ? '2px solid #4f46e5' : '2px solid transparent',
            color: tab === 'journeys' ? '#4f46e5' : 'var(--dim)',
            fontWeight: tab === 'journeys' ? 600 : 400,
          }}
        >
          Auto Journeys
        </button>
      </div>

      {tab === 'journeys' ? (
        <AutoJourneysSection campaignsEnabled={campaignsEnabled} />
      ) : (
      <>
      {disabled && (
        <div className="notice wa" style={{ marginBottom: '1rem' }}>
          <div className="notice-ico">\u2728</div>
          <div className="notice-body">
            <h4>Coming Soon</h4>
            <p>
              Marketing campaigns aren't active on your account yet. You can browse the catalog,
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
