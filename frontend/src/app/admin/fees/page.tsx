'use client';

// Admin fees overview — surfaces cancellation_fault_fee +
// platform_absorbed_fee subdocs written by orderCancellationService.
// Two stat cards above two tabs, all sharing one date filter.
//
// Patterns mirror admin/financials and admin/activity:
//   - card / cb / ch CSS classes (defined in dashboard.css)
//   - btn-p btn-sm / btn-g btn-sm tab toggles
//   - useToast() for non-fatal load errors

import type { ChangeEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import {
  getAdminFeesSummary,
  getAdminRestaurantFaults,
  getAdminPlatformAbsorbed,
  getAdminRestaurants,
} from '../../../api/admin';
import type {
  AdminFeesSummary,
  AdminRestaurantFaultFee,
  AdminPlatformAbsorbedFee,
  AdminRestaurant,
} from '../../../types';

type TabKey = 'restaurant_faults' | 'platform_absorbed';

const TABS: ReadonlyArray<{ id: TabKey; label: string }> = [
  { id: 'restaurant_faults', label: 'Restaurant Faults' },
  { id: 'platform_absorbed', label: 'Platform Absorbed' },
];

const RESTAURANT_FAULT_REASON_LABEL: Record<AdminRestaurantFaultFee['reason'], string> = {
  rejected_by_restaurant: 'Restaurant rejected',
  restaurant_timeout:     'Acceptance timeout',
};

function formatINR(n: number | null | undefined): string {
  const v = Number(n) || 0;
  return `₹${v.toFixed(2)}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Convert YYYY-MM-DD inputs into ISO range (start-of-day / end-of-day) so
// the inclusive range matches user intent. Returns undefined for empty.
function toIsoStart(d: string): string | undefined {
  return d ? new Date(`${d}T00:00:00`).toISOString() : undefined;
}
function toIsoEnd(d: string): string | undefined {
  return d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined;
}

export default function AdminFeesPage() {
  const { showToast } = useToast();

  const [fromInput, setFromInput] = useState<string>('');
  const [toInput, setToInput] = useState<string>('');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [tab, setTab] = useState<TabKey>('restaurant_faults');
  const [restaurantId, setRestaurantId] = useState<string>('');

  const [summary, setSummary] = useState<AdminFeesSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState<boolean>(true);

  const [restaurants, setRestaurants] = useState<AdminRestaurant[]>([]);
  const [faults, setFaults] = useState<AdminRestaurantFaultFee[]>([]);
  const [faultsLoading, setFaultsLoading] = useState<boolean>(false);
  const [faultsError, setFaultsError] = useState<string | null>(null);

  const [absorbed, setAbsorbed] = useState<AdminPlatformAbsorbedFee[]>([]);
  const [absorbedLoading, setAbsorbedLoading] = useState<boolean>(false);
  const [absorbedError, setAbsorbedError] = useState<string | null>(null);

  // ── Restaurant list (for the Restaurant Faults tab dropdown) ────
  useEffect(() => {
    getAdminRestaurants()
      .then((rows) => setRestaurants(Array.isArray(rows) ? rows : []))
      .catch(() => setRestaurants([]));
  }, []);

  // ── Summary fetch ──
  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const res = await getAdminFeesSummary(toIsoStart(from), toIsoEnd(to));
      setSummary(res);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const msg = e?.response?.data?.error || e?.message || 'Failed to load fees summary';
      showToast(msg, 'error');
    } finally {
      setSummaryLoading(false);
    }
  }, [from, to, showToast]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  // ── Restaurant Faults table fetch ──
  const loadFaults = useCallback(async () => {
    setFaultsLoading(true);
    setFaultsError(null);
    try {
      const res = await getAdminRestaurantFaults(
        toIsoStart(from), toIsoEnd(to), restaurantId || undefined,
      );
      setFaults(Array.isArray(res) ? res : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const msg = e?.response?.data?.error || e?.message || 'Failed to load restaurant faults';
      setFaultsError(msg);
      showToast(msg, 'error');
    } finally {
      setFaultsLoading(false);
    }
  }, [from, to, restaurantId, showToast]);

  // ── Platform Absorbed table fetch ──
  const loadAbsorbed = useCallback(async () => {
    setAbsorbedLoading(true);
    setAbsorbedError(null);
    try {
      const res = await getAdminPlatformAbsorbed(toIsoStart(from), toIsoEnd(to));
      setAbsorbed(Array.isArray(res) ? res : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const msg = e?.response?.data?.error || e?.message || 'Failed to load platform absorbed fees';
      setAbsorbedError(msg);
      showToast(msg, 'error');
    } finally {
      setAbsorbedLoading(false);
    }
  }, [from, to, showToast]);

  useEffect(() => {
    if (tab === 'restaurant_faults') loadFaults();
    else loadAbsorbed();
  }, [tab, loadFaults, loadAbsorbed]);

  const applyFilter = () => {
    setFrom(fromInput);
    setTo(toInput);
  };
  const clearFilter = () => {
    setFromInput('');
    setToInput('');
    setFrom('');
    setTo('');
  };
  const onRestaurantChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setRestaurantId(e.target.value);
  };

  const restaurantOptions = useMemo(() => {
    return [...restaurants]
      .map((r) => ({
        id: String(r.id || ''),
        name: r.name || r.brand_name || r.registered_business_name || '—',
      }))
      .filter((r) => r.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [restaurants]);

  return (
    <div id="tab-admin-fees" className="flex flex-col gap-4">
      <div>
        <h2 className="m-0">Fees</h2>
        <p className="mt-1 mb-0 text-dim text-[0.85rem]">
          Cancellation-fault and platform-absorbed fee accounting across all restaurants.
        </p>
      </div>

      {/* Shared date filter */}
      <div className="card">
        <div className="ch flex-wrap gap-2">
          <h3 className="m-0">Date range</h3>
          <div className="ml-auto flex gap-[0.4rem] items-center">
            <input
              type="date"
              id="admin-fees-from"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              className="text-[0.75rem] py-[0.28rem] px-2 border border-rim rounded-md"
            />
            <input
              type="date"
              id="admin-fees-to"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              className="text-[0.75rem] py-[0.28rem] px-2 border border-rim rounded-md"
            />
            <button type="button" className="btn-g btn-sm" onClick={applyFilter} disabled={summaryLoading}>Filter</button>
            {(from || to) && (
              <button type="button" className="btn-g btn-sm" onClick={clearFilter} disabled={summaryLoading}>Clear</button>
            )}
          </div>
        </div>
      </div>

      {/* Two summary stat cards side by side */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
        <SummaryCard
          label="Restaurant Fault Fees"
          amount={summary?.totalRestaurantFaultFees}
          count={summary?.restaurantFaultCount}
          loading={summaryLoading && !summary}
          color="var(--gb-red-500,#dc2626)"
        />
        <SummaryCard
          label="Platform Absorbed Fees"
          amount={summary?.totalPlatformAbsorbedFees}
          count={summary?.platformAbsorbedCount}
          loading={summaryLoading && !summary}
          color="var(--gb-amber-500,#d97706)"
          note="Pending Prorouting reconciliation"
        />
      </div>

      {/* Tabs */}
      <div className="card">
        <div className="ch flex-wrap gap-2">
          <div className="flex gap-[0.4rem]">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={tab === t.id ? 'btn-p btn-sm' : 'btn-g btn-sm'}
                aria-pressed={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'restaurant_faults' && (
            <div className="ml-auto">
              <select
                value={restaurantId}
                onChange={onRestaurantChange}
                className="text-[0.78rem] py-[0.3rem] px-2 border border-rim rounded-md"
              >
                <option value="">All restaurants</option>
                {restaurantOptions.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="cb">
          {tab === 'restaurant_faults' ? (
            <RestaurantFaultsTable
              rows={faults}
              loading={faultsLoading}
              error={faultsError}
            />
          ) : (
            <PlatformAbsorbedTable
              rows={absorbed}
              loading={absorbedLoading}
              error={absorbedError}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface SummaryCardProps {
  label: string;
  amount: number | undefined;
  count: number | undefined;
  loading: boolean;
  color: string;
  note?: string;
}

function SummaryCard({ label, amount, count, loading, color, note }: SummaryCardProps) {
  return (
    <div className="card mb-0">
      <div className="cb">
        <div className="text-[0.75rem] text-dim uppercase tracking-wider">
          {label}
        </div>
        <div
          className="text-[1.6rem] font-bold mt-[0.3rem]"
          // colour is the per-card amount tint passed by the parent at
          // runtime (red for restaurant faults, amber for platform
          // absorbed). Hex/var fallback strings — kept inline.
          style={{ color }}
        >
          {loading ? '…' : formatINR(amount)}
        </div>
        <div className="text-[0.8rem] text-dim mt-[0.2rem]">
          {loading ? 'Loading…' : `${Number(count) || 0} ${Number(count) === 1 ? 'incident' : 'incidents'}`}
        </div>
        {note && (
          <div className="text-[0.7rem] text-dim mt-[0.4rem] italic">
            {note}
          </div>
        )}
      </div>
    </div>
  );
}

interface RestaurantFaultsTableProps {
  rows: AdminRestaurantFaultFee[];
  loading: boolean;
  error: string | null;
}

function RestaurantFaultsTable({ rows, loading, error }: RestaurantFaultsTableProps) {
  if (loading && !rows.length) {
    return <p className="p-4 text-dim">Loading…</p>;
  }
  if (error) {
    return <p className="p-4 text-red-500">{error}</p>;
  }
  if (!rows.length) {
    return (
      <div className="empty py-6 px-4 text-center">
        <div className="ei text-[1.5rem]">✅</div>
        <h3 className="mt-[0.4rem] mb-[0.2rem]">No restaurant-fault fees in this period</h3>
        <p className="text-dim text-[0.85rem] m-0">
          Fees appear when an order is rejected or times out before acceptance.
        </p>
      </div>
    );
  }
  return (
    <div className="tbl overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-[0.72rem] text-dim uppercase tracking-wider">
            <th className="py-[0.4rem] px-[0.2rem]">Date</th>
            <th className="py-[0.4rem] px-[0.2rem]">Order #</th>
            <th className="py-[0.4rem] px-[0.2rem]">Restaurant</th>
            <th className="py-[0.4rem] px-[0.2rem] text-right">Order Value</th>
            <th className="py-[0.4rem] px-[0.2rem]">Reason</th>
            <th className="py-[0.4rem] px-[0.2rem] text-right">Fee Charged</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.orderId} className="border-t border-bd">
              <td className="py-2 px-[0.2rem] text-[0.82rem]">{formatDate(r.createdAt)}</td>
              <td className="py-2 px-[0.2rem] font-mono text-[0.82rem]">{r.orderNumber}</td>
              <td className="py-2 px-[0.2rem] text-[0.82rem]">{r.restaurantName || '—'}</td>
              <td className="py-2 px-[0.2rem] text-[0.82rem] text-right">{formatINR(r.orderTotal)}</td>
              <td className="py-2 px-[0.2rem] text-[0.82rem]">
                {RESTAURANT_FAULT_REASON_LABEL[r.reason] || r.reason || '—'}
              </td>
              <td className="py-2 px-[0.2rem] text-[0.82rem] text-right text-red-500 font-semibold">
                {formatINR(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface PlatformAbsorbedTableProps {
  rows: AdminPlatformAbsorbedFee[];
  loading: boolean;
  error: string | null;
}

function PlatformAbsorbedTable({ rows, loading, error }: PlatformAbsorbedTableProps) {
  return (
    <>
      <div className="bg-[rgba(217,119,6,0.08)] border border-[rgba(217,119,6,0.25)] rounded-lg py-[0.6rem] px-[0.8rem] mb-[0.8rem] text-[0.8rem] text-fg">
        These fees will be discussed for compensation with Prorouting.
      </div>
      {loading && !rows.length ? (
        <p className="p-4 text-dim">Loading…</p>
      ) : error ? (
        <p className="p-4 text-red-500">{error}</p>
      ) : !rows.length ? (
        <div className="empty py-6 px-4 text-center">
          <div className="ei text-[1.5rem]">✅</div>
          <h3 className="mt-[0.4rem] mb-[0.2rem]">No platform-absorbed fees in this period</h3>
          <p className="text-dim text-[0.85rem] m-0">
            Fees appear when Prorouting can&apos;t allocate a rider after the restaurant accepts.
          </p>
        </div>
      ) : (
        <div className="tbl overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-[0.72rem] text-dim uppercase tracking-wider">
                <th className="py-[0.4rem] px-[0.2rem]">Date</th>
                <th className="py-[0.4rem] px-[0.2rem]">Order #</th>
                <th className="py-[0.4rem] px-[0.2rem]">Restaurant</th>
                <th className="py-[0.4rem] px-[0.2rem] text-right">Order Value</th>
                <th className="py-[0.4rem] px-[0.2rem] text-right">Fee Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.orderId} className="border-t border-bd">
                  <td className="py-2 px-[0.2rem] text-[0.82rem]">{formatDate(r.createdAt)}</td>
                  <td className="py-2 px-[0.2rem] font-mono text-[0.82rem]">{r.orderNumber}</td>
                  <td className="py-2 px-[0.2rem] text-[0.82rem]">{r.restaurantName || '—'}</td>
                  <td className="py-2 px-[0.2rem] text-[0.82rem] text-right">{formatINR(r.orderTotal)}</td>
                  <td className="py-2 px-[0.2rem] text-[0.82rem] text-right text-amber-600 font-semibold">
                    {formatINR(r.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
