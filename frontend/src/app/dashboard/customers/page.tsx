'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  getWallet,
  getCustomerStats,
  getCustomerSegments,
  getCustomersBySegment,
} from '../../../api/restaurant';

interface SegmentMeta {
  label: string;
  emoji: string;
  desc: string;
}

const SEGMENTS: ReadonlyArray<SegmentMeta> = [
  { label: 'Champion',          emoji: '🏆', desc: 'Recent, frequent, high spend' },
  { label: 'Loyal',             emoji: '🤝', desc: 'Frequent, reliable customers' },
  { label: 'Big Spender',       emoji: '💎', desc: 'High order value' },
  { label: 'Potential Loyalist',emoji: '🌱', desc: 'Returning, building frequency' },
  { label: 'New Customer',      emoji: '🆕', desc: 'First 1–2 orders, recent' },
  { label: 'At Risk',           emoji: '⚠️',  desc: 'Was frequent, drifting away' },
  { label: 'Hibernating',       emoji: '💤', desc: 'Inactive, moderate spend' },
  { label: 'Lost',              emoji: '🚫', desc: 'Long gone, single order' },
  { label: 'Other',             emoji: '•',  desc: 'Uncategorized' },
];

interface WalletData {
  campaigns_enabled?: boolean;
}

interface CustomerStats {
  total_customers?: number;
  active_last_30_days?: number;
  total_spend_rs?: number | string;
  total_orders?: number;
  last_rebuild_at?: string;
}

interface SegmentRow {
  label: string;
  count?: number;
}

interface SegmentsResponse {
  segments?: SegmentRow[];
}

interface SegmentTopCustomer {
  customer_id: string;
  name?: string;
  phone_masked?: string;
  order_count?: number;
  total_spend_rs?: number | string;
  avg_order_value_rs?: number | string;
  last_order_at?: string;
}

interface SegmentTopResponse {
  items?: SegmentTopCustomer[];
}

function rupees(n: number | string | null | undefined): string {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface TileProps {
  title: string;
  value: string | number;
  hint?: string;
}

function Tile({ title, value, hint }: TileProps) {
  return (
    <div className="card py-4 px-[1.1rem] flex flex-col gap-1">
      <div className="text-[0.72rem] text-mute font-semibold uppercase tracking-wider">{title}</div>
      <div className="text-2xl font-bold text-[#111827]">{value}</div>
      {hint && <div className="text-[0.78rem] text-mute">{hint}</div>}
    </div>
  );
}

interface SegmentCardProps {
  seg: SegmentMeta;
  count: number;
  disabled: boolean;
  selected: boolean;
  onClick: () => void;
}

function SegmentCard({ seg, count, disabled, selected, onClick }: SegmentCardProps) {
  const borderCls = selected ? 'border-2 border-[#059669]' : 'border border-[#e5e7eb]';
  const bgCls = disabled ? 'bg-[#f9fafb]' : 'bg-white';
  const cursorCls = disabled ? 'cursor-not-allowed opacity-[0.65]' : 'cursor-pointer';
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`text-left p-4 rounded-[10px] ${borderCls} ${bgCls} ${cursorCls} relative flex flex-col gap-[0.35rem]`}
    >
      <div className="flex items-center gap-[0.55rem]">
        <span className="text-xl" aria-hidden="true">{seg.emoji}</span>
        <span className="font-bold text-[0.92rem] text-[#111827]">{seg.label}</span>
      </div>
      <div className="text-[1.3rem] font-extrabold text-[#059669]">{count}</div>
      <div className="text-xs text-mute">{seg.desc}</div>
      {disabled && (
        <span className="absolute top-[0.55rem] right-[0.65rem] text-[0.65rem] font-bold bg-[#fef3c7] text-[#92400e] py-[0.12rem] px-[0.45rem] rounded-full uppercase tracking-[0.04em]">
          Soon
        </span>
      )}
    </button>
  );
}

export default function CustomersPage() {
  const [campaignsEnabled, setCampaignsEnabled] = useState<boolean>(false);
  const [stats, setStats] = useState<CustomerStats | null>(null);
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [topRows, setTopRows] = useState<SegmentTopCustomer[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [walletRaw, sRaw, segRaw] = await Promise.all([
          getWallet().catch(() => ({})),
          getCustomerStats().catch(() => null),
          getCustomerSegments().catch(() => ({ segments: [] })),
        ]);
        if (cancelled) return;
        const wallet = walletRaw as WalletData;
        const seg = segRaw as SegmentsResponse;
        setCampaignsEnabled(Boolean(wallet?.campaigns_enabled));
        setStats(sRaw as CustomerStats | null);
        setSegments(seg?.segments || []);
      } catch (e: unknown) {
        const err = e as { message?: string };
        if (!cancelled) setError(err?.message || 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedLabel || !campaignsEnabled) { setTopRows([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = (await getCustomersBySegment(selectedLabel, 5)) as SegmentTopResponse | null;
        if (!cancelled) setTopRows(data?.items || []);
      } catch {
        if (!cancelled) setTopRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedLabel, campaignsEnabled]);

  const segCountMap = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    (segments || []).forEach((r) => m.set(r.label, r.count || 0));
    return m;
  }, [segments]);

  if (loading) {
    return (
      <div className="p-5">
        <div className="text-[#6b7280]">Loading customers…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {!campaignsEnabled && (
        <div className="notice wa">
          <div className="notice-ico">✨</div>
          <div className="notice-body">
            <h4>Customer Segments — Coming Soon</h4>
            <p>
              We&apos;re profiling your customers nightly into RFM segments (Champions, Loyal,
              At Risk, and more). Targeted campaigns unlock once the campaigns feature is
              enabled for your account. Your data is already being prepared.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="notice bg-[#fef2f2] border-[#fecaca]">
          <div className="notice-body"><p>{error}</p></div>
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-[0.9rem]">
        <Tile
          title="Total customers"
          value={stats?.total_customers ?? 0}
          hint="Profiled from paid orders"
        />
        <Tile
          title="Active last 30 days"
          value={stats?.active_last_30_days ?? 0}
          hint="Ordered in the last month"
        />
        <Tile
          title="Lifetime revenue"
          value={rupees(stats?.total_spend_rs)}
          hint={`${stats?.total_orders || 0} orders`}
        />
        <Tile
          title="Last rebuild"
          value={formatDate(stats?.last_rebuild_at)}
          hint="Nightly refresh"
        />
      </div>

      <div className="card">
        <div className="ch"><h3>Segments</h3></div>
        <div className="cb">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-[0.8rem]">
            {SEGMENTS.map((seg) => (
              <SegmentCard
                key={seg.label}
                seg={seg}
                count={segCountMap.get(seg.label) || 0}
                disabled={!campaignsEnabled}
                selected={selectedLabel === seg.label}
                onClick={() => setSelectedLabel(seg.label)}
              />
            ))}
          </div>
        </div>
      </div>

      {campaignsEnabled && selectedLabel && (
        <div className="card">
          <div className="ch"><h3>Top 5 — {selectedLabel}</h3></div>
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Orders</th>
                  <th>Total Spend</th>
                  <th>Avg Order</th>
                  <th>Last Order</th>
                </tr>
              </thead>
              <tbody>
                {topRows.length === 0 && (
                  <tr><td colSpan={6} className="text-[#6b7280] p-4">No customers in this segment.</td></tr>
                )}
                {topRows.map((r) => (
                  <tr key={r.customer_id}>
                    <td>{r.name || '—'}</td>
                    <td>{r.phone_masked}</td>
                    <td>{r.order_count}</td>
                    <td>{rupees(r.total_spend_rs)}</td>
                    <td>{rupees(r.avg_order_value_rs)}</td>
                    <td>{formatDate(r.last_order_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
