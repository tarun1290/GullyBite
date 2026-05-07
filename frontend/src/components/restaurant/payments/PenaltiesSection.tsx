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
    <div id="tab-penalties-wrap" className="flex flex-col gap-4">
      <div>
        <h2 className="m-0">Penalties</h2>
        <p className="mt-1 text-dim text-[0.85rem]">
          Charges applied to your account due to order cancellations.
        </p>
      </div>

      <div className="card mb-0">
        <div className="ch flex-wrap gap-2">
          <h3 className="m-0">Total Penalty Charges</h3>
          <div className="ml-auto flex gap-[0.4rem] items-center">
            <input
              type="date"
              id="penalties-from"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              className="text-[0.75rem] py-[0.28rem] px-2 border border-rim rounded-md"
            />
            <input
              type="date"
              id="penalties-to"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              className="text-[0.75rem] py-[0.28rem] px-2 border border-rim rounded-md"
            />
            <button type="button" className="btn-g btn-sm" onClick={applyFilter} disabled={loading}>Filter</button>
            {(from || to) && (
              <button type="button" className="btn-g btn-sm" onClick={clearFilter} disabled={loading}>Clear</button>
            )}
          </div>
        </div>
        <div className="cb">
          <div className={`text-[1.6rem] font-bold ${total > 0 ? 'text-red-500' : 'text-fg'}`}>
            {formatINR(total)}
          </div>
          <div className="text-[0.75rem] text-dim mt-[0.2rem]">
            {rows.length} {rows.length === 1 ? 'charge' : 'charges'}
            {(from || to) ? ' in selected period' : ' (all-time)'}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="ch">
          <h3 className="m-0">Penalty Breakdown</h3>
        </div>
        <div className="tbl">
          {loading && !data ? (
            <p className="p-4 text-dim">Loading…</p>
          ) : error ? (
            <p className="p-4 text-red-500">{error}</p>
          ) : rows.length === 0 ? (
            <div className="empty py-6 px-4 text-center">
              <div className="ei text-[1.5rem]">✅</div>
              <h3 className="mt-[0.4rem] mb-[0.2rem]">No penalty charges in this period</h3>
              <p className="text-dim text-[0.85rem] m-0">
                Penalty charges appear when an order is rejected or times out before acceptance.
              </p>
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-[0.72rem] text-dim uppercase tracking-wider">
                  <th className="py-[0.4rem] px-[0.2rem]">Order #</th>
                  <th className="py-[0.4rem] px-[0.2rem]">Date</th>
                  <th className="py-[0.4rem] px-[0.2rem] text-right">Order Value</th>
                  <th className="py-[0.4rem] px-[0.2rem]">Reason</th>
                  <th className="py-[0.4rem] px-[0.2rem] text-right">Fee Charged</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.orderId} className="border-t border-bd">
                    <td className="py-2 px-[0.2rem] font-mono text-[0.82rem]">
                      {r.orderNumber}
                    </td>
                    <td className="py-2 px-[0.2rem] text-[0.82rem]">
                      {formatDate(r.createdAt)}
                    </td>
                    <td className="py-2 px-[0.2rem] text-[0.82rem] text-right">
                      {formatINR(r.orderTotal)}
                    </td>
                    <td className="py-2 px-[0.2rem] text-[0.82rem]">
                      {REASON_LABEL[r.reason] || r.reason || '—'}
                    </td>
                    <td className="py-2 px-[0.2rem] text-[0.82rem] text-right text-red-500 font-semibold">
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
