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
    <div
      className="card"
      style={{
        padding: '1rem 1.1rem',
        display: 'flex', flexDirection: 'column', gap: '.25rem',
      }}
    >
      <div style={{
        fontSize: '.72rem', color: 'var(--mute, #6b7280)',
        fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em',
      }}>{title}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827' }}>{value}</div>
      {hint && <div style={{ fontSize: '.78rem', color: 'var(--mute, #6b7280)' }}>{hint}</div>}
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
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        textAlign: 'left',
        padding: '1rem',
        borderRadius: 10,
        border: selected ? '2px solid #059669' : '1px solid #e5e7eb',
        background: disabled ? '#f9fafb' : '#fff',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.65 : 1,
        position: 'relative',
        display: 'flex', flexDirection: 'column', gap: '.35rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '.55rem' }}>
        <span style={{ fontSize: '1.25rem' }} aria-hidden="true">{seg.emoji}</span>
        <span style={{ fontWeight: 700, fontSize: '.92rem', color: '#111827' }}>{seg.label}</span>
      </div>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#059669' }}>{count}</div>
      <div style={{ fontSize: '.75rem', color: 'var(--mute, #6b7280)' }}>{seg.desc}</div>
      {disabled && (
        <span style={{
          position: 'absolute', top: '.55rem', right: '.65rem',
          fontSize: '.65rem', fontWeight: 700,
          background: '#fef3c7', color: '#92400e',
          padding: '.12rem .45rem', borderRadius: 999,
          textTransform: 'uppercase', letterSpacing: '.04em',
        }}>
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
      <div style={{ padding: '1.25rem' }}>
        <div style={{ color: '#6b7280' }}>Loading customers…</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
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
        <div className="notice" style={{ background: '#fef2f2', borderColor: '#fecaca' }}>
          <div className="notice-body"><p>{error}</p></div>
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '.9rem',
      }}>
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
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: '.8rem',
          }}>
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
                  <tr><td colSpan={6} style={{ color: '#6b7280', padding: '1rem' }}>No customers in this segment.</td></tr>
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
