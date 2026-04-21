import { useEffect, useState } from 'react';
import Card from '../../components/Card.jsx';
import StatCard from '../../components/StatCard.jsx';
import { getPlatformMarketingSnapshot } from '../../api/admin.js';

// AdminPlatformAnalytics (Prompt 10) — platform-wide marketing roll-up.
// Distinct from the legacy operational AdminAnalytics tab. Reads the
// aggregated snapshot from /api/admin/platform-marketing/snapshot,
// which is cached 6h server-side.

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

export default function AdminPlatformAnalytics() {
  const [period, setPeriod] = useState('30d');
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPlatformMarketingSnapshot(period)
      .then((res) => {
        if (cancelled) return;
        if (!res || res.ok === false) {
          setError('Could not load platform analytics.');
          setSnapshot(null);
        } else {
          setSnapshot(res.data || null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError('Could not load platform analytics.');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [period]);

  const t = snapshot?.totals || {};
  const counts = snapshot?.counts || {};
  const top = snapshot?.top_restaurants_by_roi || [];

  return (
    <div id="tab-platform-marketing">
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

      <Card title="Platform headline">
        {loading ? (
          <div style={{ padding: '1rem 0', color: '#94a3b8', fontSize: '.85rem' }}>Loading…</div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: '.7rem',
            }}
          >
            <StatCard label="Campaigns sent" value={fmtNum(t.campaigns)} />
            <StatCard label="Messages delivered" value={fmtPct(t.delivery_rate)} />
            <StatCard label="Conversions" value={fmtNum(t.conversions)} />
            <StatCard label="Revenue attributed" value={fmtRs(t.revenue_attributed_rs)} />
            <StatCard label="Marketing spend" value={fmtRs(t.marketing_spend_rs)} />
            <StatCard
              label="Platform ROI"
              value={t.platform_roi == null ? '—' : t.platform_roi.toFixed(2) + 'x'}
            />
          </div>
        )}
      </Card>

      <div style={{ height: '1.1rem' }} />

      <Card title="Marketplace activity">
        {loading ? (
          <div style={{ padding: '1rem 0', color: '#94a3b8', fontSize: '.85rem' }}>Loading…</div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: '.7rem',
            }}
          >
            <StatCard label="Paid orders" value={fmtNum(t.paid_orders)} />
            <StatCard label="Paid revenue" value={fmtRs(t.paid_revenue_rs)} />
            <StatCard label="Transacting restaurants" value={fmtNum(t.transacting_restaurants)} />
            <StatCard label="Feedback responses" value={fmtNum(t.feedback_total)} />
            <StatCard label="Avg. rating" value={t.feedback_avg_rating != null ? t.feedback_avg_rating + ' / 5' : '—'} />
            <StatCard label="Auto-journey sends" value={fmtNum(t.journey_sends)} />
          </div>
        )}
      </Card>

      <div style={{ height: '1.1rem' }} />

      <Card title="Top 5 restaurants by ROI">
        {loading ? (
          <div style={{ padding: '1rem 0', color: '#94a3b8', fontSize: '.85rem' }}>Loading…</div>
        ) : top.length === 0 ? (
          <div style={{ padding: '1rem 0', color: '#94a3b8', fontSize: '.85rem' }}>
            No restaurants with marketing spend in this period.
          </div>
        ) : (
          <table className="data-table" style={{ width: '100%', fontSize: '.85rem' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Restaurant</th>
                <th>Campaigns</th>
                <th>Revenue</th>
                <th>Spend</th>
                <th>ROI</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => (
                <tr key={r.restaurant_id}>
                  <td style={{ textAlign: 'left' }}>
                    {r.restaurant_name}
                    <div style={{ fontSize: '.7rem', color: '#94a3b8' }}>
                      <code>{r.restaurant_id}</code>
                    </div>
                  </td>
                  <td>{fmtNum(r.campaigns)}</td>
                  <td>{fmtRs(r.revenue_rs)}</td>
                  <td>{fmtRs(r.spend_rs)}</td>
                  <td>{r.roi == null ? '—' : r.roi.toFixed(2) + 'x'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div style={{ height: '1.1rem' }} />

      <Card title="Adoption">
        {loading ? (
          <div style={{ padding: '1rem 0', color: '#94a3b8', fontSize: '.85rem' }}>Loading…</div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '.7rem',
            }}
          >
            <StatCard
              label="Restaurants with campaigns enabled"
              value={fmtNum(counts.restaurants_with_campaigns_enabled)}
            />
            <StatCard
              label="Restaurants with loyalty active"
              value={fmtNum(counts.restaurants_with_loyalty_active)}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
