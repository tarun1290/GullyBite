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
    <div id="tab-admin-fees" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div>
        <h2 style={{ margin: 0 }}>Fees</h2>
        <p style={{ margin: '.25rem 0 0', color: 'var(--dim)', fontSize: '.85rem' }}>
          Cancellation-fault and platform-absorbed fee accounting across all restaurants.
        </p>
      </div>

      {/* Shared date filter */}
      <div className="card">
        <div className="ch" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
          <h3 style={{ margin: 0 }}>Date range</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem', alignItems: 'center' }}>
            <input
              type="date"
              id="admin-fees-from"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              style={{ fontSize: '.75rem', padding: '.28rem .5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
            />
            <input
              type="date"
              id="admin-fees-to"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              style={{ fontSize: '.75rem', padding: '.28rem .5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
            />
            <button type="button" className="btn-g btn-sm" onClick={applyFilter} disabled={summaryLoading}>Filter</button>
            {(from || to) && (
              <button type="button" className="btn-g btn-sm" onClick={clearFilter} disabled={summaryLoading}>Clear</button>
            )}
          </div>
        </div>
      </div>

      {/* Two summary stat cards side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
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
        <div className="ch" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
          <div style={{ display: 'flex', gap: '.4rem' }}>
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
            <div style={{ marginLeft: 'auto' }}>
              <select
                value={restaurantId}
                onChange={onRestaurantChange}
                style={{ fontSize: '.78rem', padding: '.3rem .5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
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
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="cb">
        <div style={{ fontSize: '.75rem', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          {label}
        </div>
        <div style={{ fontSize: '1.6rem', fontWeight: 700, color, marginTop: '.3rem' }}>
          {loading ? '…' : formatINR(amount)}
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--dim)', marginTop: '.2rem' }}>
          {loading ? 'Loading…' : `${Number(count) || 0} ${Number(count) === 1 ? 'incident' : 'incidents'}`}
        </div>
        {note && (
          <div style={{ fontSize: '.7rem', color: 'var(--dim)', marginTop: '.4rem', fontStyle: 'italic' }}>
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
    return <p style={{ padding: '1rem', color: 'var(--dim)' }}>Loading…</p>;
  }
  if (error) {
    return <p style={{ padding: '1rem', color: 'var(--gb-red-500,#dc2626)' }}>{error}</p>;
  }
  if (!rows.length) {
    return (
      <div className="empty" style={{ padding: '1.5rem 1rem', textAlign: 'center' }}>
        <div className="ei" style={{ fontSize: '1.5rem' }}>✅</div>
        <h3 style={{ margin: '.4rem 0 .2rem' }}>No restaurant-fault fees in this period</h3>
        <p style={{ color: 'var(--dim)', fontSize: '.85rem', margin: 0 }}>
          Fees appear when an order is rejected or times out before acceptance.
        </p>
      </div>
    );
  }
  return (
    <div className="tbl" style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', fontSize: '.72rem', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
            <th style={{ padding: '.4rem .2rem' }}>Date</th>
            <th style={{ padding: '.4rem .2rem' }}>Order #</th>
            <th style={{ padding: '.4rem .2rem' }}>Restaurant</th>
            <th style={{ padding: '.4rem .2rem', textAlign: 'right' }}>Order Value</th>
            <th style={{ padding: '.4rem .2rem' }}>Reason</th>
            <th style={{ padding: '.4rem .2rem', textAlign: 'right' }}>Fee Charged</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.orderId} style={{ borderTop: '1px solid var(--bd)' }}>
              <td style={{ padding: '.5rem .2rem', fontSize: '.82rem' }}>{formatDate(r.createdAt)}</td>
              <td style={{ padding: '.5rem .2rem', fontFamily: 'monospace', fontSize: '.82rem' }}>{r.orderNumber}</td>
              <td style={{ padding: '.5rem .2rem', fontSize: '.82rem' }}>{r.restaurantName || '—'}</td>
              <td style={{ padding: '.5rem .2rem', fontSize: '.82rem', textAlign: 'right' }}>{formatINR(r.orderTotal)}</td>
              <td style={{ padding: '.5rem .2rem', fontSize: '.82rem' }}>
                {RESTAURANT_FAULT_REASON_LABEL[r.reason] || r.reason || '—'}
              </td>
              <td style={{ padding: '.5rem .2rem', fontSize: '.82rem', textAlign: 'right', color: 'var(--gb-red-500,#dc2626)', fontWeight: 600 }}>
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
      <div style={{
        background: 'rgba(217,119,6,0.08)',
        border: '1px solid rgba(217,119,6,0.25)',
        borderRadius: 8,
        padding: '.6rem .8rem',
        marginBottom: '.8rem',
        fontSize: '.8rem',
        color: 'var(--fg)',
      }}>
        These fees will be discussed for compensation with Prorouting.
      </div>
      {loading && !rows.length ? (
        <p style={{ padding: '1rem', color: 'var(--dim)' }}>Loading…</p>
      ) : error ? (
        <p style={{ padding: '1rem', color: 'var(--gb-red-500,#dc2626)' }}>{error}</p>
      ) : !rows.length ? (
        <div className="empty" style={{ padding: '1.5rem 1rem', textAlign: 'center' }}>
          <div className="ei" style={{ fontSize: '1.5rem' }}>✅</div>
          <h3 style={{ margin: '.4rem 0 .2rem' }}>No platform-absorbed fees in this period</h3>
          <p style={{ color: 'var(--dim)', fontSize: '.85rem', margin: 0 }}>
            Fees appear when Prorouting can&apos;t allocate a rider after the restaurant accepts.
          </p>
        </div>
      ) : (
        <div className="tbl" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: '.72rem', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                <th style={{ padding: '.4rem .2rem' }}>Date</th>
                <th style={{ padding: '.4rem .2rem' }}>Order #</th>
                <th style={{ padding: '.4rem .2rem' }}>Restaurant</th>
                <th style={{ padding: '.4rem .2rem', textAlign: 'right' }}>Order Value</th>
                <th style={{ padding: '.4rem .2rem', textAlign: 'right' }}>Fee Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.orderId} style={{ borderTop: '1px solid var(--bd)' }}>
                  <td style={{ padding: '.5rem .2rem', fontSize: '.82rem' }}>{formatDate(r.createdAt)}</td>
                  <td style={{ padding: '.5rem .2rem', fontFamily: 'monospace', fontSize: '.82rem' }}>{r.orderNumber}</td>
                  <td style={{ padding: '.5rem .2rem', fontSize: '.82rem' }}>{r.restaurantName || '—'}</td>
                  <td style={{ padding: '.5rem .2rem', fontSize: '.82rem', textAlign: 'right' }}>{formatINR(r.orderTotal)}</td>
                  <td style={{ padding: '.5rem .2rem', fontSize: '.82rem', textAlign: 'right', color: 'var(--gb-amber-500,#d97706)', fontWeight: 600 }}>
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
