'use client';

// Marketing-analytics header strips, lifted verbatim out of the
// (being-deleted) marketing-analytics page so the Campaign Performance
// + Auto Journeys roll-ups survive on the campaigns page. Self-contained:
// owns its own period state, data fetching, and the lifted SectionCard /
// StatGrid / fmt* helpers. Consumes the { ok, data } section responses
// only — no shape changes.

import { useEffect, useState, type ReactNode } from 'react';
import Card from '../../../components/Card';
import StatCard from '../../../components/StatCard';
import { getCampaignSummary, getJourneySummary } from '../../../api/restaurant';

const PERIODS: ReadonlyArray<readonly [string, string]> = [
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];

function fmtRs(n: number | string | null | undefined): string {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(1) + 'Cr';
  if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
  if (Math.abs(v) >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
  return '₹' + v.toFixed(0);
}

function fmtPct(ratio: number | string | null | undefined): string {
  if (ratio == null || Number.isNaN(Number(ratio))) return '—';
  return (Number(ratio) * 100).toFixed(1) + '%';
}

function fmtNum(n: number | string | null | undefined): string {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-IN');
}

interface SectionCardProps {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  empty?: string | null;
  loading?: boolean;
}

function SectionCard({ title, subtitle, children, empty, loading }: SectionCardProps) {
  return (
    <Card title={title} className="marketing-analytics-section">
      {subtitle && (
        <div className="text-sm text-slate-500 mb-3">
          {subtitle}
        </div>
      )}
      {loading ? (
        <div className="py-4 px-0 text-slate-400 text-base">Loading…</div>
      ) : empty ? (
        <div className="py-4 px-0 text-slate-400 text-base">{empty}</div>
      ) : (
        children
      )}
    </Card>
  );
}

// Tailwind v4 — no dynamic class strings. `cols` is only ever 2/3/4 so
// map it through a literal lookup instead of an inline gridTemplateColumns.
const COL_CLASS: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
};

interface StatGridProps { children?: ReactNode; cols?: number }

function StatGrid({ children, cols = 4 }: StatGridProps) {
  return (
    <div className={`grid gap-3 ${COL_CLASS[cols] || COL_CLASS[4]}`}>
      {children}
    </div>
  );
}

// ───────────────────────────── Section data shapes ─────────────────

interface CampaignTotals {
  total_campaigns?: number;
  sent?: number;
  delivery_rate?: number;
  read_rate?: number;
  reply_rate?: number;
  converted?: number;
  conversion_rate?: number;
  roi?: number | null;
  // Present on the live /campaigns response; the spend cards read these
  // off the same payload (no separate revenue endpoint — it's deleted).
  spend_rs?: number | string;
  revenue_attributed_rs?: number | string;
}

interface TopTemplate {
  template_id: string;
  use_case?: string;
  campaigns?: number;
  sent?: number;
  conversion_rate?: number;
  revenue_rs?: number | string;
  spend_rs?: number | string;
  roi?: number | null;
}

interface CampaignData {
  totals?: CampaignTotals;
  top_templates?: TopTemplate[];
}

interface JourneyTypeRow {
  journey_type: string;
  sends: number;
  enabled: boolean;
}

interface JourneysData {
  total_sends?: number;
  by_type?: JourneyTypeRow[];
}

interface SectionResponse<T> {
  ok?: boolean;
  data?: T;
  err?: unknown;
}

// ───────────────────────── Campaign performance ────────────────────

interface CampaignSectionProps { data?: CampaignData | undefined; loading: boolean }

function CampaignSection({ data, loading }: CampaignSectionProps) {
  const empty = !loading && (!data || data.totals?.total_campaigns === 0);
  return (
    <SectionCard
      title="Campaign Performance"
      subtitle="Manual marketing blasts — sent, delivered, converted, ROI."
      loading={loading}
      empty={empty ? 'No campaigns sent in this period.' : null}
    >
      {data && data.totals && (
        <>
          <StatGrid cols={4}>
            <StatCard label="Campaigns" value={fmtNum(data.totals.total_campaigns)} />
            <StatCard label="Messages sent" value={fmtNum(data.totals.sent)} />
            <StatCard label="Delivery rate" value={fmtPct(data.totals.delivery_rate)} />
            <StatCard label="Read rate" value={fmtPct(data.totals.read_rate)} />
            <StatCard label="Reply rate" value={fmtPct(data.totals.reply_rate)} />
            <StatCard label="Conversions" value={fmtNum(data.totals.converted)} />
            <StatCard label="Conversion rate" value={fmtPct(data.totals.conversion_rate)} />
            <StatCard
              label="ROI"
              value={data.totals.roi == null ? '—' : data.totals.roi.toFixed(2) + 'x'}
            />
          </StatGrid>
          {Array.isArray(data.top_templates) && data.top_templates.length > 0 && (
            <>
              <div className="text-sm text-slate-500 mt-5 mb-2">
                Top templates by ROI
              </div>
              <table className="data-table w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left">Template</th>
                    <th>Campaigns</th>
                    <th>Sent</th>
                    <th>Conv.</th>
                    <th>Revenue</th>
                    <th>Spend</th>
                    <th>ROI</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_templates.map((t) => (
                    <tr key={t.template_id}>
                      <td className="text-left">
                        <code className="text-xs">{t.template_id}</code>
                        {t.use_case && (
                          <span className="text-slate-400 ml-1">({t.use_case})</span>
                        )}
                      </td>
                      <td>{fmtNum(t.campaigns)}</td>
                      <td>{fmtNum(t.sent)}</td>
                      <td>{fmtPct(t.conversion_rate)}</td>
                      <td>{fmtRs(t.revenue_rs)}</td>
                      <td>{fmtRs(t.spend_rs)}</td>
                      <td>{t.roi == null ? '—' : t.roi.toFixed(2) + 'x'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </SectionCard>
  );
}

// ─────────────────────────── Auto journeys ─────────────────────────

interface JourneysSectionProps { data?: JourneysData | undefined; loading: boolean }

function JourneysSection({ data, loading }: JourneysSectionProps) {
  const empty = !loading && (!data || data.total_sends === 0);
  return (
    <SectionCard
      title="Auto Journeys"
      subtitle="Automated drips — birthday, win-back, abandoned-cart, etc."
      loading={loading}
      empty={empty ? 'No auto-journey sends in this period.' : null}
    >
      {data && (data.total_sends ?? 0) > 0 && (
        <>
          <StatGrid cols={2}>
            <StatCard label="Total sends" value={fmtNum(data.total_sends)} />
            <StatCard label="Journey types active" value={fmtNum((data.by_type || []).length)} />
          </StatGrid>
          <table className="data-table w-full mt-4 text-sm">
            <thead>
              <tr>
                <th className="text-left">Journey</th>
                <th>Sends</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {(data.by_type || []).map((r) => (
                <tr key={r.journey_type}>
                  <td className="text-left">{r.journey_type}</td>
                  <td>{fmtNum(r.sends)}</td>
                  <td>{r.enabled ? '✅' : '⏸'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </SectionCard>
  );
}

// Shared period chips for the strips. Scoped to whichever strip renders
// it — the campaigns page has no page-level period control to reuse.
interface PeriodChipsProps { period: string; onChange: (p: string) => void }

function PeriodChips({ period, onChange }: PeriodChipsProps) {
  return (
    <div className="chips mb-4">
      {PERIODS.map(([val, label]) => (
        <button
          key={val}
          type="button"
          className={period === val ? 'chip on' : 'chip'}
          onClick={() => onChange(val)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── Exported strips ─────────────────────────

// Manual Campaigns header strip: Campaign Performance + 3 spend cards,
// both sourced from the SAME getCampaignSummary response. Net is derived
// client-side (revenue_attributed_rs − spend_rs), mirroring the old
// RevenueSection's net card.
export function CampaignAnalyticsStrip() {
  const [period, setPeriod] = useState<string>('30d');
  const [loading, setLoading] = useState<boolean>(true);
  const [data, setData] = useState<CampaignData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCampaignSummary(period)
      .then((raw) => {
        if (cancelled) return;
        const res = raw as SectionResponse<CampaignData> | null | undefined;
        if (!res || res.ok === false) {
          setData(null);
        } else {
          setData(res.data || null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [period]);

  const totals = data?.totals;
  const spend = Number(totals?.spend_rs || 0);
  const revenue = Number(totals?.revenue_attributed_rs || 0);
  const net = revenue - spend;
  const showSpend = !loading && Boolean(totals);

  return (
    <div className="mb-4">
      <PeriodChips period={period} onChange={setPeriod} />
      <div className="flex flex-col gap-4">
        <CampaignSection data={data || undefined} loading={loading} />
        {showSpend && (
          <StatGrid cols={3}>
            <StatCard label="Marketing spend" value={fmtRs(spend)} />
            <StatCard label="Campaign revenue" value={fmtRs(revenue)} />
            <StatCard
              label="Net contribution"
              value={fmtRs(net)}
              deltaType={net >= 0 ? 'up' : 'down'}
            />
          </StatGrid>
        )}
      </div>
    </div>
  );
}

// Auto Journeys header strip: lifted JourneysSection sourced from
// getJourneySummary.
export function JourneysAnalyticsStrip() {
  const [period, setPeriod] = useState<string>('30d');
  const [loading, setLoading] = useState<boolean>(true);
  const [data, setData] = useState<JourneysData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getJourneySummary(period)
      .then((raw) => {
        if (cancelled) return;
        const res = raw as SectionResponse<JourneysData> | null | undefined;
        if (!res || res.ok === false) {
          setData(null);
        } else {
          setData(res.data || null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [period]);

  return (
    <div className="mb-4">
      <PeriodChips period={period} onChange={setPeriod} />
      <JourneysSection data={data || undefined} loading={loading} />
    </div>
  );
}
