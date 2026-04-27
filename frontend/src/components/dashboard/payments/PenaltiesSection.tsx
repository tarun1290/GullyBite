'use client';

// Restaurant-side cancellation-fault-fee history. Driven by
// GET /api/restaurant/penalties — every order with a cancellation_fault_fee
// subdocument (REJECTED_BY_RESTAURANT or RESTAURANT_TIMEOUT) shows up
// here as a line item that the next settlement payout will deduct.
//
// Mirrors the layout conventions of SettlementsSection.tsx: card +
// .ch heading row + date inputs + .tbl wrapper around a <table>.

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../Toast';
import { getPenalties } from '../../../api/restaurant';
import type { CancellationFaultFee, PenaltiesSummary } from '../../../types';

const REASON_LABEL: Record<CancellationFaultFee['reason'], string> = {
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

export default function PenaltiesSection() {
  const { showToast } = useToast();

  const [fromInput, setFromInput] = useState<string>('');
  const [toInput, setToInput] = useState<string>('');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');

  const [data, setData] = useState<PenaltiesSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Convert YYYY-MM-DD inputs to ISO date boundaries: from = start of
      // day, to = end of day (so the inclusive range matches user intent).
      const fromIso = from ? new Date(`${from}T00:00:00`).toISOString() : undefined;
      const toIso   = to   ? new Date(`${to}T23:59:59.999`).toISOString() : undefined;
      const res = await getPenalties(fromIso, toIso);
      setData(res || { totalFaultFees: 0, faultFees: [] });
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const msg = e?.response?.data?.error || e?.message || 'Failed to load penalties';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [from, to, showToast]);

  useEffect(() => { load(); }, [load]);

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

  const total = data?.totalFaultFees || 0;
  const rows = data?.faultFees || [];

  return (
    <div id="tab-penalties-wrap" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div>
        <h2 style={{ margin: 0 }}>Penalties</h2>
        <p style={{ margin: '.25rem 0 0', color: 'var(--dim)', fontSize: '.85rem' }}>
          Charges applied to your account due to order cancellations.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 0 }}>
        <div className="ch" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
          <h3 style={{ margin: 0 }}>Total Penalty Charges</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem', alignItems: 'center' }}>
            <input
              type="date"
              id="penalties-from"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              style={{ fontSize: '.75rem', padding: '.28rem .5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
            />
            <input
              type="date"
              id="penalties-to"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              style={{ fontSize: '.75rem', padding: '.28rem .5rem', border: '1px solid var(--rim)', borderRadius: 6 }}
            />
            <button type="button" className="btn-g btn-sm" onClick={applyFilter} disabled={loading}>Filter</button>
            {(from || to) && (
              <button type="button" className="btn-g btn-sm" onClick={clearFilter} disabled={loading}>Clear</button>
            )}
          </div>
        </div>
        <div className="cb">
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: total > 0 ? 'var(--gb-red-500,#dc2626)' : 'var(--fg)' }}>
            {formatINR(total)}
          </div>
          <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginTop: '.2rem' }}>
            {rows.length} {rows.length === 1 ? 'charge' : 'charges'}
            {(from || to) ? ' in selected period' : ' (all-time)'}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="ch">
          <h3 style={{ margin: 0 }}>Penalty Breakdown</h3>
        </div>
        <div className="tbl">
          {loading && !data ? (
            <p style={{ padding: '1rem', color: 'var(--dim)' }}>Loading…</p>
          ) : error ? (
            <p style={{ padding: '1rem', color: 'var(--gb-red-500,#dc2626)' }}>{error}</p>
          ) : rows.length === 0 ? (
            <div className="empty" style={{ padding: '1.5rem 1rem', textAlign: 'center' }}>
              <div className="ei" style={{ fontSize: '1.5rem' }}>✅</div>
              <h3 style={{ margin: '.4rem 0 .2rem' }}>No penalty charges in this period</h3>
              <p style={{ color: 'var(--dim)', fontSize: '.85rem', margin: 0 }}>
                Penalty charges appear when an order is rejected or times out before acceptance.
              </p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', fontSize: '.72rem', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  <th style={{ padding: '.4rem .2rem' }}>Order #</th>
                  <th style={{ padding: '.4rem .2rem' }}>Date</th>
                  <th style={{ padding: '.4rem .2rem', textAlign: 'right' }}>Order Value</th>
                  <th style={{ padding: '.4rem .2rem' }}>Reason</th>
                  <th style={{ padding: '.4rem .2rem', textAlign: 'right' }}>Fee Charged</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.orderId} style={{ borderTop: '1px solid var(--bd)' }}>
                    <td style={{ padding: '.5rem .2rem', fontFamily: 'monospace', fontSize: '.82rem' }}>
                      {r.orderNumber}
                    </td>
                    <td style={{ padding: '.5rem .2rem', fontSize: '.82rem' }}>
                      {formatDate(r.createdAt)}
                    </td>
                    <td style={{ padding: '.5rem .2rem', fontSize: '.82rem', textAlign: 'right' }}>
                      {formatINR(r.orderTotal)}
                    </td>
                    <td style={{ padding: '.5rem .2rem', fontSize: '.82rem' }}>
                      {REASON_LABEL[r.reason] || r.reason || '—'}
                    </td>
                    <td style={{ padding: '.5rem .2rem', fontSize: '.82rem', textAlign: 'right', color: 'var(--gb-red-500,#dc2626)', fontWeight: 600 }}>
                      −{formatINR(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
