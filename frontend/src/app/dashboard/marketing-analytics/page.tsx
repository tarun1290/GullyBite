'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Card from '../../../components/Card';
import StatCard from '../../../components/StatCard';
import {
  getMarketingAnalyticsDashboard,
  getWallet,
} from '../../../api/restaurant';

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
        <div className="text-[0.78rem] text-[#64748b] mb-[0.8rem]">
          {subtitle}
        </div>
      )}
      {loading ? (
        <div className="py-4 px-0 text-[#94a3b8] text-[0.85rem]">Loading…</div>
      ) : empty ? (
        <div className="py-4 px-0 text-[#94a3b8] text-[0.85rem]">{empty}</div>
      ) : (
        children
      )}
    </Card>
  );
}

interface StatGridProps { children?: ReactNode; cols?: number }

function StatGrid({ children, cols = 4 }: StatGridProps) {
  return (
    <div
      className="grid gap-[0.7rem]"
      // dynamic gridTemplateColumns: number of columns (`cols`) is a runtime prop
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}

// ───────────────────────────── Section data shapes ─────────────────

interface RevenueData {
  orders?: number;
  revenue_rs?: number | string;
  aov_rs?: number | string;
  unique_customers?: number;
  campaign_attributed_revenue_rs?: number | string;
  campaign_attributed_share?: number;
  marketing_spend_rs?: number | string;
  net_marketing_contribution_rs?: number;
}

interface CampaignTotals {
  total_campaigns?: number;
  sent?: number;
  delivery_rate?: number;
  read_rate?: number;
  reply_rate?: number;
  converted?: number;
  conversion_rate?: number;
  roi?: number | null;
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

interface RfmRow { label: string; count: number }
interface AcquisitionRow { source: string; count: number }

interface CustomerData {
  total_customers?: number;
  new_customers_in_period?: number;
  rfm_distribution?: RfmRow[];
  acquisition_sources?: AcquisitionRow[];
}

interface LoyaltyData {
  program_active?: boolean;
  enrolled_customers?: number;
  outstanding_points?: number;
  outstanding_liability_rs?: number | string;
  lifetime_points?: number;
  points_earned_in_period?: number;
  points_redeemed_in_period?: number;
  redemption_count_in_period?: number;
  redemption_value_rs?: number | string;
}

interface RatingDistRow { rating: number | string; count: number }
interface BySourceRow { source: string; count: number; avg_rating?: number | null }

interface FeedbackData {
  total?: number;
  avg_rating?: number | null;
  positive_share?: number;
  review_link_ctr?: number;
  rating_distribution?: RatingDistRow[];
  by_source?: BySourceRow[];
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

interface DashboardData {
  revenue?: RevenueData;
  campaigns?: CampaignData;
  customers?: CustomerData;
  loyalty?: LoyaltyData;
  feedback?: FeedbackData;
  journeys?: JourneysData;
}

interface DashboardResponse {
  ok?: boolean;
  data?: DashboardData;
  err?: unknown;
}

interface WalletData {
  campaigns_enabled?: boolean;
}

// ───────────────────────────── Revenue ─────────────────────────────

interface RevenueSectionProps { data?: RevenueData | undefined; loading: boolean }

function RevenueSection({ data, loading }: RevenueSectionProps) {
  const empty = !loading && (!data || data.orders === 0);
  return (
    <SectionCard
      title="Revenue & Earnings"
      subtitle="Paid orders in the selected period, with marketing attribution."
      loading={loading}
      empty={empty ? 'No paid orders in this period.' : null}
    >
      {data && (
        <StatGrid cols={4}>
          <StatCard label="Revenue" value={fmtRs(data.revenue_rs)} />
          <StatCard label="Paid orders" value={fmtNum(data.orders)} />
          <StatCard label="Avg. order value" value={fmtRs(data.aov_rs)} />
          <StatCard label="Unique customers" value={fmtNum(data.unique_customers)} />
          <StatCard label="Campaign revenue" value={fmtRs(data.campaign_attributed_revenue_rs)} />
          <StatCard label="Campaign share" value={fmtPct(data.campaign_attributed_share)} />
          <StatCard label="Marketing spend" value={fmtRs(data.marketing_spend_rs)} />
          <StatCard
            label="Net contribution"
            value={fmtRs(data.net_marketing_contribution_rs)}
            deltaType={(data.net_marketing_contribution_rs ?? 0) >= 0 ? 'up' : 'down'}
          />
        </StatGrid>
      )}
    </SectionCard>
  );
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
              <div className="text-[0.78rem] text-[#64748b] mt-[1.2rem] mb-2">
                Top templates by ROI
              </div>
              <table className="data-table w-full text-[0.82rem]">
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
                        <code className="text-[0.76rem]">{t.template_id}</code>
                        {t.use_case && (
                          <span className="text-[#94a3b8] ml-[0.3rem]">({t.use_case})</span>
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

// ─────────────────────────── Customer insights ─────────────────────

interface CustomerSectionProps { data?: CustomerData | undefined; loading: boolean }

function CustomerSection({ data, loading }: CustomerSectionProps) {
  const empty = !loading && (!data || data.total_customers === 0);
  return (
    <SectionCard
      title="Customer Insights"
      subtitle="Lifetime customer base, RFM mix, and acquisition sources."
      loading={loading}
      empty={empty ? 'No customer data yet.' : null}
    >
      {data && (
        <>
          <StatGrid cols={3}>
            <StatCard label="Total customers" value={fmtNum(data.total_customers)} />
            <StatCard label="New in period" value={fmtNum(data.new_customers_in_period)} />
            <StatCard
              label="RFM segments"
              value={fmtNum(data.rfm_distribution?.length || 0)}
            />
          </StatGrid>
          <div className="grid grid-cols-2 gap-[1.1rem] mt-4">
            <div>
              <div className="text-[0.78rem] text-[#64748b] mb-[0.4rem]">
                RFM distribution
              </div>
              <ul className="list-none p-0 m-0 text-[0.82rem]">
                {(data.rfm_distribution || []).map((r) => (
                  <li
                    key={r.label}
                    className="flex justify-between py-1 px-0"
                  >
                    <span>{r.label}</span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
                {(data.rfm_distribution || []).length === 0 && (
                  <li className="text-[#94a3b8]">No data.</li>
                )}
              </ul>
            </div>
            <div>
              <div className="text-[0.78rem] text-[#64748b] mb-[0.4rem]">
                Acquisition sources
              </div>
              <ul className="list-none p-0 m-0 text-[0.82rem]">
                {(data.acquisition_sources || []).slice(0, 8).map((r) => (
                  <li
                    key={r.source}
                    className="flex justify-between py-1 px-0"
                  >
                    <span>{r.source}</span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
                {(data.acquisition_sources || []).length === 0 && (
                  <li className="text-[#94a3b8]">No data.</li>
                )}
              </ul>
            </div>
          </div>
        </>
      )}
    </SectionCard>
  );
}

// ───────────────────────────── Loyalty ─────────────────────────────

interface LoyaltySectionProps { data?: LoyaltyData | undefined; loading: boolean }

function LoyaltySection({ data, loading }: LoyaltySectionProps) {
  const inactive = !loading && data && !data.program_active;
  return (
    <SectionCard
      title="Loyalty Program"
      subtitle="Points earned, redeemed, outstanding liability."
      loading={loading}
      empty={inactive ? 'Loyalty program is inactive. Enable it from the Loyalty tab.' : null}
    >
      {data && data.program_active && (
        <StatGrid cols={4}>
          <StatCard label="Enrolled" value={fmtNum(data.enrolled_customers)} />
          <StatCard label="Outstanding points" value={fmtNum(data.outstanding_points)} />
          <StatCard label="Liability" value={fmtRs(data.outstanding_liability_rs)} />
          <StatCard label="Lifetime points" value={fmtNum(data.lifetime_points)} />
          <StatCard label="Points earned" value={fmtNum(data.points_earned_in_period)} />
          <StatCard label="Points redeemed" value={fmtNum(data.points_redeemed_in_period)} />
          <StatCard label="Redemptions" value={fmtNum(data.redemption_count_in_period)} />
          <StatCard label="Redemption value" value={fmtRs(data.redemption_value_rs)} />
        </StatGrid>
      )}
    </SectionCard>
  );
}

// ──────────────────────── Feedback & reviews ───────────────────────

interface FeedbackSectionProps { data?: FeedbackData | undefined; loading: boolean }

function FeedbackSection({ data, loading }: FeedbackSectionProps) {
  const empty = !loading && (!data || data.total === 0);
  return (
    <SectionCard
      title="Feedback & Reviews"
      subtitle="Ratings, positive share, Google-review link click-through."
      loading={loading}
      empty={empty ? 'No feedback collected yet in this period.' : null}
    >
      {data && (data.total ?? 0) > 0 && (
        <>
          <StatGrid cols={4}>
            <StatCard label="Responses" value={fmtNum(data.total)} />
            <StatCard label="Avg. rating" value={data.avg_rating != null ? data.avg_rating + ' / 5' : '—'} />
            <StatCard label="Positive" value={fmtPct(data.positive_share)} />
            <StatCard label="Review-link CTR" value={fmtPct(data.review_link_ctr)} />
          </StatGrid>
          <div className="grid grid-cols-2 gap-[1.1rem] mt-4">
            <div>
              <div className="text-[0.78rem] text-[#64748b] mb-[0.4rem]">
                Rating distribution
              </div>
              <ul className="list-none p-0 m-0 text-[0.82rem]">
                {(data.rating_distribution || []).map((r) => (
                  <li
                    key={r.rating}
                    className="flex justify-between py-1 px-0"
                  >
                    <span>{'★'.repeat(Number(r.rating))}</span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-[0.78rem] text-[#64748b] mb-[0.4rem]">
                By source
              </div>
              <ul className="list-none p-0 m-0 text-[0.82rem]">
                {(data.by_source || []).map((r) => (
                  <li
                    key={r.source}
                    className="flex justify-between py-1 px-0"
                  >
                    <span>
                      {r.source}
                      {r.avg_rating != null && (
                        <span className="text-[#94a3b8] ml-[0.3rem]">
                          ({r.avg_rating}★)
                        </span>
                      )}
                    </span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          </div>
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
          <table className="data-table w-full mt-4 text-[0.82rem]">
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

// ───────────────────────────── Root ───────────────────────────────

export default function MarketingAnalyticsPage() {
  const [period, setPeriod] = useState<string>('30d');
  const [loading, setLoading] = useState<boolean>(true);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getMarketingAnalyticsDashboard(period).catch((e: unknown) => ({ ok: false, err: e })),
      getWallet().catch(() => ({})),
    ]).then(([resRaw, wRaw]) => {
      if (cancelled) return;
      const res = resRaw as DashboardResponse | null | undefined;
      const w = wRaw as WalletData | null | undefined;
      if (!res || res.ok === false) {
        setError('Could not load analytics. Try again.');
        setData(null);
      } else {
        setData(res.data || null);
      }
      setWallet(w || {});
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [period]);

  const campaignsEnabled = Boolean(wallet?.campaigns_enabled);

  return (
    <div id="tab-marketing-analytics">
      {!campaignsEnabled && !loading && (
        <div className="bg-[#fef3c7] border border-[#fde68a] rounded-lg py-3 px-4 text-[0.85rem] text-[#92400e] mb-[1.1rem]">
          <strong>Marketing is not enabled yet.</strong> Top up your wallet and enable campaigns
          from the Campaigns tab to populate these insights.
        </div>
      )}

      <div className="chips mb-[1.1rem]">
        {PERIODS.map(([val, label]) => (
          <button
            key={val}
            type="button"
            className={period === val ? 'chip on' : 'chip'}
            onClick={() => setPeriod(val)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-[#fee2e2] border border-[#fecaca] rounded-lg py-3 px-4 text-[0.85rem] text-[#991b1b] mb-[1.1rem]">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-[1.1rem]">
        <RevenueSection data={data?.revenue} loading={loading} />
        <CampaignSection data={data?.campaigns} loading={loading} />
        <CustomerSection data={data?.customers} loading={loading} />
        <LoyaltySection data={data?.loyalty} loading={loading} />
        <FeedbackSection data={data?.feedback} loading={loading} />
        <JourneysSection data={data?.journeys} loading={loading} />
      </div>
    </div>
  );
}
