'use client';

import { useEffect, useState } from 'react';
import Card from '../../../components/Card';
import StatCard from '../../../components/StatCard';
import { getPlatformMarketingSnapshot } from '../../../api/admin';

const PERIODS: ReadonlyArray<readonly [string, string]> = [
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];

interface SnapshotTotals {
  campaigns?: number;
  delivery_rate?: number;
  conversions?: number;
  revenue_attributed_rs?: number | string;
  marketing_spend_rs?: number | string;
  platform_roi?: number;
  paid_orders?: number;
  paid_revenue_rs?: number | string;
  transacting_restaurants?: number;
  feedback_total?: number;
  feedback_avg_rating?: number;
  journey_sends?: number;
}

interface SnapshotCounts {
  restaurants_with_campaigns_enabled?: number;
  restaurants_with_loyalty_active?: number;
}

interface TopRestaurant {
  restaurant_id: string;
  restaurant_name?: string;
  campaigns?: number;
  revenue_rs?: number | string;
  spend_rs?: number | string;
  roi?: number;
}

interface SnapshotData {
  totals?: SnapshotTotals;
  counts?: SnapshotCounts;
  top_restaurants_by_roi?: TopRestaurant[];
}

interface SnapshotResponse {
  ok?: boolean;
  data?: SnapshotData;
}

function fmtRs(n: number | string | null | undefined): string {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(1) + 'Cr';
  if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
  if (Math.abs(v) >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
  return '₹' + v.toFixed(0);
}

function fmtPct(ratio: number | null | undefined): string {
  if (ratio == null || Number.isNaN(ratio)) return '—';
  return (Number(ratio) * 100).toFixed(1) + '%';
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-IN');
}

export default function AdminPlatformAnalyticsPage() {
  const [period, setPeriod] = useState<string>('30d');
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (getPlatformMarketingSnapshot(period) as Promise<SnapshotResponse | null>)
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

  const t: SnapshotTotals = snapshot?.totals || {};
  const counts: SnapshotCounts = snapshot?.counts || {};
  const top: TopRestaurant[] = snapshot?.top_restaurants_by_roi || [];

  const LOAD_CLS = 'py-4 text-slate-400 text-[0.85rem]';

  return (
    <div id="tab-platform-marketing">
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
        <div className="bg-red-100 border border-red-200 rounded-lg py-3 px-4 text-[0.85rem] text-red-900 mb-[1.1rem]">
          {error}
        </div>
      )}

      <Card title="Platform headline">
        {loading ? (
          <div className={LOAD_CLS}>Loading…</div>
        ) : (
          <div className="grid grid-cols-3 gap-[0.7rem]">
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

      <div className="h-[1.1rem]" />

      <Card title="Marketplace activity">
        {loading ? (
          <div className={LOAD_CLS}>Loading…</div>
        ) : (
          <div className="grid grid-cols-3 gap-[0.7rem]">
            <StatCard label="Paid orders" value={fmtNum(t.paid_orders)} />
            <StatCard label="Paid revenue" value={fmtRs(t.paid_revenue_rs)} />
            <StatCard label="Transacting restaurants" value={fmtNum(t.transacting_restaurants)} />
            <StatCard label="Feedback responses" value={fmtNum(t.feedback_total)} />
            <StatCard label="Avg. rating" value={t.feedback_avg_rating != null ? t.feedback_avg_rating + ' / 5' : '—'} />
            <StatCard label="Auto-journey sends" value={fmtNum(t.journey_sends)} />
          </div>
        )}
      </Card>

      <div className="h-[1.1rem]" />

      <Card title="Top 5 restaurants by ROI">
        {loading ? (
          <div className={LOAD_CLS}>Loading…</div>
        ) : top.length === 0 ? (
          <div className={LOAD_CLS}>
            No restaurants with marketing spend in this period.
          </div>
        ) : (
          <table className="data-table w-full text-[0.85rem]">
            <thead>
              <tr>
                <th className="text-left">Restaurant</th>
                <th>Campaigns</th>
                <th>Revenue</th>
                <th>Spend</th>
                <th>ROI</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => (
                <tr key={r.restaurant_id}>
                  <td className="text-left">
                    {r.restaurant_name}
                    <div className="text-[0.7rem] text-slate-400">
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

      <div className="h-[1.1rem]" />

      <Card title="Adoption">
        {loading ? (
          <div className={LOAD_CLS}>Loading…</div>
        ) : (
          <div className="grid grid-cols-2 gap-[0.7rem]">
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
