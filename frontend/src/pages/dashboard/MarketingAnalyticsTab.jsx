import { useEffect, useState } from 'react';
import Card from '../../components/Card.jsx';
import StatCard from '../../components/StatCard.jsx';
import {
  getMarketingAnalyticsDashboard,
  getWallet,
} from '../../api/restaurant.js';

// Marketing Analytics (Prompt 10) — separate from the legacy operational
// Analytics tab. Aggregates marketing_campaigns, journey_send_log,
// customer_rfm_profiles, feedback_events, loyalty_* and paid orders
// into six vertical sections. Each section is cached 1h server-side.

const PERIODS = [
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];

function fmtRs(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(1) + 'Cr';
  if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
  if (Math.abs(v) >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
  return '₹' + v.toFixed(0);
}

function fmtPct(ratio) {
  if (ratio == null || Number.isNaN(ratio)) return '—';
  return (Number(ratio) * 100).toFixed(1) + '%';
}

function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-IN');
}

function SectionCard({ title, subtitle, children, empty, loading }) {
  return (
    <Card title={title} className="marketing-analytics-section">
      {subtitle && (
        <div style={{ fontSize: '.78rem', color: '#64748b', marginBottom: '.8rem' }}>
          {subtitle}
        </div>
      )}
      {loading ? (
        <div style={{ padding: '1rem 0', color: '#94a3b8', fontSize: '.85rem' }}>Loading…</div>
      ) : empty ? (
        <div style={{ padding: '1rem 0', color: '#94a3b8', fontSize: '.85rem' }}>{empty}</div>
      ) : (
        children
      )}
    </Card>
  );
}

function StatGrid({ children, cols = 4 }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gap: '.7rem',
      }}
    >
      {children}
    </div>
  );
}

// ───────────────────────────── Revenue ─────────────────────────────
function RevenueSection({ data, loading }) {
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
            deltaType={data.net_marketing_contribution_rs >= 0 ? 'up' : 'down'}
          />
        </StatGrid>
      )}
    </SectionCard>
  );
}

// ───────────────────────── Campaign performance ────────────────────
function CampaignSection({ data, loading }) {
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
              <div style={{ fontSize: '.78rem', color: '#64748b', margin: '1.2rem 0 .5rem' }}>
                Top templates by ROI
              </div>
              <table className="data-table" style={{ width: '100%', fontSize: '.82rem' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Template</th>
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
                      <td style={{ textAlign: 'left' }}>
                        <code style={{ fontSize: '.76rem' }}>{t.template_id}</code>
                        {t.use_case && (
                          <span style={{ color: '#94a3b8', marginLeft: '.3rem' }}>({t.use_case})</span>
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
function CustomerSection({ data, loading }) {
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.1rem', marginTop: '1rem' }}>
            <div>
              <div style={{ fontSize: '.78rem', color: '#64748b', marginBottom: '.4rem' }}>
                RFM distribution
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '.82rem' }}>
                {(data.rfm_distribution || []).map((r) => (
                  <li
                    key={r.label}
                    style={{ display: 'flex', justifyContent: 'space-between', padding: '.25rem 0' }}
                  >
                    <span>{r.label}</span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
                {(data.rfm_distribution || []).length === 0 && (
                  <li style={{ color: '#94a3b8' }}>No data.</li>
                )}
              </ul>
            </div>
            <div>
              <div style={{ fontSize: '.78rem', color: '#64748b', marginBottom: '.4rem' }}>
                Acquisition sources
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '.82rem' }}>
                {(data.acquisition_sources || []).slice(0, 8).map((r) => (
                  <li
                    key={r.source}
                    style={{ display: 'flex', justifyContent: 'space-between', padding: '.25rem 0' }}
                  >
                    <span>{r.source}</span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
                {(data.acquisition_sources || []).length === 0 && (
                  <li style={{ color: '#94a3b8' }}>No data.</li>
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
function LoyaltySection({ data, loading }) {
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
function FeedbackSection({ data, loading }) {
  const empty = !loading && (!data || data.total === 0);
  return (
    <SectionCard
      title="Feedback & Reviews"
      subtitle="Ratings, positive share, Google-review link click-through."
      loading={loading}
      empty={empty ? 'No feedback collected yet in this period.' : null}
    >
      {data && data.total > 0 && (
        <>
          <StatGrid cols={4}>
            <StatCard label="Responses" value={fmtNum(data.total)} />
            <StatCard label="Avg. rating" value={data.avg_rating != null ? data.avg_rating + ' / 5' : '—'} />
            <StatCard label="Positive" value={fmtPct(data.positive_share)} />
            <StatCard label="Review-link CTR" value={fmtPct(data.review_link_ctr)} />
          </StatGrid>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.1rem', marginTop: '1rem' }}>
            <div>
              <div style={{ fontSize: '.78rem', color: '#64748b', marginBottom: '.4rem' }}>
                Rating distribution
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '.82rem' }}>
                {(data.rating_distribution || []).map((r) => (
                  <li
                    key={r.rating}
                    style={{ display: 'flex', justifyContent: 'space-between', padding: '.25rem 0' }}
                  >
                    <span>{'★'.repeat(Number(r.rating))}</span>
                    <strong>{fmtNum(r.count)}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div style={{ fontSize: '.78rem', color: '#64748b', marginBottom: '.4rem' }}>
                By source
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '.82rem' }}>
                {(data.by_source || []).map((r) => (
                  <li
                    key={r.source}
                    style={{ display: 'flex', justifyContent: 'space-between', padding: '.25rem 0' }}
                  >
                    <span>
                      {r.source}
                      {r.avg_rating != null && (
                        <span style={{ color: '#94a3b8', marginLeft: '.3rem' }}>
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
function JourneysSection({ data, loading }) {
  const empty = !loading && (!data || data.total_sends === 0);
  return (
    <SectionCard
      title="Auto Journeys"
      subtitle="Automated drips — birthday, win-back, abandoned-cart, etc."
      loading={loading}
      empty={empty ? 'No auto-journey sends in this period.' : null}
    >
      {data && data.total_sends > 0 && (
        <>
          <StatGrid cols={2}>
            <StatCard label="Total sends" value={fmtNum(data.total_sends)} />
            <StatCard label="Journey types active" value={fmtNum((data.by_type || []).length)} />
          </StatGrid>
          <table className="data-table" style={{ width: '100%', marginTop: '1rem', fontSize: '.82rem' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Journey</th>
                <th>Sends</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {(data.by_type || []).map((r) => (
                <tr key={r.journey_type}>
                  <td style={{ textAlign: 'left' }}>{r.journey_type}</td>
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
export default function MarketingAnalyticsTab() {
  const [period, setPeriod] = useState('30d');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [wallet, setWallet] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getMarketingAnalyticsDashboard(period).catch((e) => ({ ok: false, err: e })),
      getWallet().catch(() => ({})),
    ]).then(([res, w]) => {
      if (cancelled) return;
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

  const campaignsEnabled = !!wallet?.campaigns_enabled;

  return (
    <div id="tab-marketing-analytics">
      {!campaignsEnabled && !loading && (
        <div
          style={{
            background: '#fef3c7',
            border: '1px solid #fde68a',
            borderRadius: '.5rem',
            padding: '.75rem 1rem',
            fontSize: '.85rem',
            color: '#92400e',
            marginBottom: '1.1rem',
          }}
        >
          <strong>Marketing is not enabled yet.</strong> Top up your wallet and enable campaigns
          from the Campaigns tab to populate these insights.
        </div>
      )}

      <div className="chips" style={{ marginBottom: '1.1rem' }}>
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
        <div
          style={{
            background: '#fee2e2',
            border: '1px solid #fecaca',
            borderRadius: '.5rem',
            padding: '.75rem 1rem',
            fontSize: '.85rem',
            color: '#991b1b',
            marginBottom: '1.1rem',
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
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
