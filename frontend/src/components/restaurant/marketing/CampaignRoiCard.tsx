'use client';

import { useCallback, useMemo, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import { getCampaignAnalytics } from '../../../api/restaurant';

const SORT_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['roi', 'Sort: ROI'],
  ['revenue', 'Sort: Revenue'],
  ['cost', 'Sort: Cost'],
  ['orders', 'Sort: Orders'],
  ['created', 'Sort: Newest'],
];

const SORT_KEY: Record<string, keyof RoiRow> = {
  roi: 'roi',
  revenue: 'revenue',
  cost: 'cost',
  orders: 'orders_generated',
  created: 'created_at',
};

interface RoiRow {
  campaign_id?: string;
  id?: string;
  campaign_name?: string;
  type?: string;
  messages_sent?: number;
  cost?: number | string;
  orders_generated?: number;
  revenue?: number | string;
  roi?: number | null;
  created_at?: string;
}

interface RoiResponse {
  items?: RoiRow[];
}

function formatRoi(r?: number | null): string {
  if (r == null) return '—';
  const label = r >= 10 ? r.toFixed(0) : r.toFixed(2);
  return `${label}x`;
}

function roiColorClass(r?: number | null): string {
  if (r == null) return 'text-dim';
  return r >= 1 ? 'text-wa' : 'text-red';
}

export default function CampaignRoiCard() {
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [sort, setSort] = useState<string>('roi');

  const { data, loading, error, refetch } = useAnalyticsFetch<RoiResponse | null>(
    useCallback(() => {
      const params: Record<string, string> = {};
      if (from) params.from = from;
      if (to) params.to = to;
      return getCampaignAnalytics(params) as Promise<RoiResponse | null>;
    }, [from, to]),
    [from, to],
  );

  const rows = useMemo<RoiRow[]>(() => {
    const items = (data?.items || []).slice();
    const key = SORT_KEY[sort] || 'roi';
    items.sort((a, b) => {
      if (key === 'created_at') {
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      }
      const av = a[key]; const bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return Number(bv) - Number(av);
    });
    return items;
  }, [data, sort]);

  return (
    <div className="card mt-[1.2rem]">
      <div className="ch flex items-center gap-[0.8rem] flex-wrap">
        <h3 className="m-0">Campaign ROI</h3>
        <span className="text-dim text-[0.78rem]">
          Revenue attributed from orders within 24h of send
        </span>
        <div className="ml-auto flex gap-[0.4rem] items-center">
          <input
            type="date"
            className="inp w-auto py-[0.3rem] px-2"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <input
            type="date"
            className="inp w-auto py-[0.3rem] px-2"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <select
            className="inp w-auto py-[0.3rem] px-2"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="button" className="btn-g btn-sm" onClick={refetch}>↻</button>
        </div>
      </div>
      <div className="tbl">
        {error ? (
          <div className="p-4">
            <SectionError message={error} onRetry={refetch} />
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Messages</th>
                <th>Cost</th>
                <th>Orders</th>
                <th>Revenue</th>
                <th>ROI</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={6} className="text-center p-4 text-dim">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6}>
                  <div className="empty">
                    <div className="ei">📊</div>
                    <h3>No campaign data yet</h3>
                    <p>ROI appears after messages are sent and orders land</p>
                  </div>
                </td></tr>
              ) : (
                rows.map((r, idx) => (
                  <tr key={r.campaign_id || r.id || idx}>
                    <td>
                      {r.campaign_name}
                      <br />
                      <span className="text-[0.7rem] text-dim">{r.type || ''}</span>
                    </td>
                    <td>{r.messages_sent || 0}</td>
                    <td>₹{Number(r.cost || 0).toFixed(2)}</td>
                    <td>{r.orders_generated || 0}</td>
                    <td className={`font-bold ${roiColorClass(r.roi)}`}>{formatRoi(r.roi)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
