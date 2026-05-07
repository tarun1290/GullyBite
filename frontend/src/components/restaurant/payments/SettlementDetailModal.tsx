'use client';

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useToast } from '../../Toast';
import {
  getSettlementById,
  getSettlementMetaBreakdown,
  downloadSettlement,
  getBranches,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

const STATUS_CLS: Record<string, string> = { PAID: 'bg', PENDING: 'ba', PROCESSING: 'bb', FAILED: 'br' };

// Field names mirror the actual settlement document written by
// jobs/settlement.js (insertOne at line 142). The backend route
// GET /api/restaurant/financials/settlements/:id returns
// { settlement, orders } with the raw document inline as `settlement`.
// Names use _rs suffixes everywhere except for status/timestamp fields.
interface SettlementDoc {
  // Period + status
  period_start?: string;
  period_end?: string;
  payout_status?: string;
  payout_utr?: string | null;
  payout_at?: string | null;
  payout_completed_at?: string | null;
  // Revenue breakdown
  food_revenue_rs?: number;
  food_gst_collected_rs?: number;
  packaging_collected_rs?: number;
  packaging_gst_rs?: number;
  delivery_fee_collected_rs?: number;
  // Deductions
  platform_fee_rs?: number;
  platform_fee_gst_rs?: number;
  delivery_fee_restaurant_share_rs?: number;
  delivery_fee_restaurant_gst_rs?: number;
  discount_total_rs?: number;
  refund_total_rs?: number;
  tds_amount_rs?: number;
  tds_applicable?: boolean;
  referral_fee_rs?: number;
  referral_fee_gst_rs?: number;
  // Cancellation penalties (REJECTED_BY_RESTAURANT / RESTAURANT_TIMEOUT
  // Razorpay-fee debits accumulated against the restaurant). Backed by
  // services/orderCancellationService — will be ₹0 until jobs/settlement.js
  // drains restaurants.pending_cancellation_fault_fees_paise into the
  // settlement row. Known gap, not a bug.
  cancellation_fault_fees?: number;
  // Totals
  gross_revenue_rs?: number;
  net_payout_rs?: number;
}

interface SettlementOrder {
  _id?: string;
  order_number?: string;
  display_order_id?: string;
  delivered_at?: string;
  created_at?: string;
  total_rs?: number;
  status?: string;
}

// Wrapper returned by the backend route.
interface SettlementDetail {
  settlement?: SettlementDoc;
  orders?: SettlementOrder[];
}

interface MetaItem {
  id?: string;
  customer_name?: string;
  phone?: string;
  message_type?: string;
  cost?: number | string;
  sent_at?: string;
}

interface MetaData {
  meta_message_count?: number;
  meta_cost_total_paise?: number;
  items?: MetaItem[];
}

function formatINR(n: number | undefined | null): string {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

interface BdLineProps { label: string; value: number | undefined; sign: '+' | '-' | '' }

function BdLine({ label, value, sign }: BdLineProps) {
  const colorClass = sign === '-' ? 'text-red' : sign === '+' ? 'text-wa' : 'text-tx';
  return (
    <div className="flex justify-between">
      <span className="text-dim">{label}</span>
      <span className={colorClass}>{sign || ''} {formatINR(Math.abs(value || 0))}</span>
    </div>
  );
}

interface BdTotalProps { label: string; value: number | undefined; colorClass?: string }

function BdTotal({ label, value, colorClass = 'text-tx' }: BdTotalProps) {
  return (
    <div className="flex justify-between font-bold">
      <span className={colorClass}>{label}</span>
      <span className={colorClass}>{formatINR(value || 0)}</span>
    </div>
  );
}

const DASH: ReactNode = <div className="border-t border-dashed border-rim my-[0.3rem]" />;

interface MetaBreakdownProps { data: MetaData | null }

function MetaBreakdown({ data }: MetaBreakdownProps) {
  if (!data || !data.meta_message_count) return null;
  const totalRs = ((data.meta_cost_total_paise || 0) / 100).toFixed(2);
  const items = data.items || [];
  return (
    <div className="mb-4">
      <details className="bg-ink4 rounded-lg py-[0.8rem] px-4">
        <summary className="cursor-pointer flex justify-between items-center gap-4">
          <span className="font-bold text-tx">Meta Messaging Charges</span>
          <span className="text-[0.8rem] text-dim">
            {data.meta_message_count} message{data.meta_message_count === 1 ? '' : 's'}
            {' · '}
            <span className="text-red">− ₹{totalRs}</span>
          </span>
        </summary>
        <div className="max-h-[220px] overflow-auto mt-[0.6rem] border border-rim rounded-md">
          <table className="w-full text-[0.78rem]">
            <thead>
              <tr>
                <th className="py-[0.4rem] px-[0.6rem] text-left">Customer</th>
                <th className="py-[0.4rem] px-[0.6rem] text-left">Phone</th>
                <th className="py-[0.4rem] px-[0.6rem] text-left">Type</th>
                <th className="py-[0.4rem] px-[0.6rem] text-left">Cost</th>
                <th className="py-[0.4rem] px-[0.6rem] text-left">Time</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m, idx) => (
                <tr key={m.id || idx}>
                  <td className="py-[0.4rem] px-[0.6rem]">{m.customer_name || '—'}</td>
                  <td className="py-[0.4rem] px-[0.6rem] font-mono text-dim">{m.phone || '—'}</td>
                  <td className="py-[0.4rem] px-[0.6rem]">{m.message_type || '—'}</td>
                  <td className="py-[0.4rem] px-[0.6rem]">₹{Number(m.cost || 0).toFixed(2)}</td>
                  <td className="py-[0.4rem] px-[0.6rem] text-dim text-[0.75rem]">
                    {m.sent_at ? new Date(m.sent_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

interface SettlementDetailModalProps {
  settlementId: string;
  onClose: () => void;
}

export default function SettlementDetailModal({ settlementId, onClose }: SettlementDetailModalProps) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<SettlementDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<MetaData | null>(null);
  const [downloading, setDownloading] = useState<boolean>(false);
  // Branch filter — same shape as SettlementsSection's payments-log
  // dropdown. null = "All Branches" → branch_id is omitted from the
  // query, server returns the full settlement order list. Backend also
  // re-validates the id against the restaurant's branch set so a stale
  // value can't leak cross-tenant data.
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBranches()
      .then((rows) => { if (!cancelled) setBranches(Array.isArray(rows) ? rows : []); })
      .catch(() => { /* dropdown silently degrades to "All Branches" only */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!settlementId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Don't reset `detail` on a branch-only refetch — the settlement
    // breakdown panel reads restaurant-wide totals that don't change
    // with the branch. Leaving `detail` in place avoids flashing
    // "Loading…" over the breakdown every dropdown change; the orders
    // list updates atomically when the response lands.
    const params = selectedBranchId ? { branch_id: selectedBranchId } : {};
    getSettlementById(settlementId, params)
      .then((d) => { if (!cancelled) setDetail(d as SettlementDetail | null); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e as { response?: { data?: { error?: string } }; message?: string };
        setError(err?.response?.data?.error || err?.message || 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [settlementId, selectedBranchId]);

  // Meta-breakdown is settlement-wide (not branch-scoped), so it only
  // needs to (re)load when the settlement itself changes.
  useEffect(() => {
    if (!settlementId) return undefined;
    let cancelled = false;
    setMeta(null);
    getSettlementMetaBreakdown(settlementId)
      .then((m) => { if (!cancelled) setMeta(m as MetaData | null); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [settlementId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const resp = await downloadSettlement(settlementId);
      const headers = resp.headers as Record<string, string | undefined>;
      const cd = headers?.['content-disposition'] || '';
      const match = cd.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || `settlement_${settlementId}.xlsx`;
      const blob = resp.data instanceof Blob ? resp.data : new Blob([resp.data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Download failed', 'error');
    } finally {
      setDownloading(false);
    }
  };

  // Backend returns { settlement, orders } — pull the raw settlement doc
  // out of the wrapper. (Old code was casting the entire wrapper as a
  // breakdown, which silently produced all-zero rows.)
  const settlementDoc: SettlementDoc = detail?.settlement || {};
  const statusKey = settlementDoc.payout_status?.toUpperCase?.() || '';
  const statusCls = STATUS_CLS[statusKey] || 'bd';
  const paidAtRaw = settlementDoc.payout_completed_at || settlementDoc.payout_at;
  const paidAtDisplay = paidAtRaw
    ? new Date(paidAtRaw).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '';
  const periodDisplay = (raw?: string | null): string => {
    if (!raw) return '';
    const d = new Date(raw);
    return Number.isNaN(d.getTime())
      ? String(raw)
      : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  return (
    <div
      onClick={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onClose?.(); }}
      className="fixed inset-0 bg-[rgba(15,23,42,0.55)] backdrop-blur-xs z-200 flex items-center justify-center p-6"
    >
      <div className="bg-ink2 rounded-xl max-w-[720px] w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="py-4 px-[1.3rem] border-b border-rim flex items-center justify-between">
          <span className="font-bold text-[0.95rem] text-tx">Settlement Detail</span>
          <button type="button" className="btn-g btn-sm" onClick={onClose}>✕</button>
        </div>
        <div className="p-[1.3rem] max-h-[75vh] overflow-y-auto text-[0.84rem]">
          {error ? (
            <div className="text-center p-8 text-red">
              Error: {error}
            </div>
          ) : loading || !detail ? (
            <div className="text-center p-8 text-dim">Loading…</div>
          ) : (
            <>
              <div className="flex justify-between items-start mb-4 flex-wrap gap-[0.6rem]">
                <div>
                  <div className="text-[0.72rem] text-dim mb-[0.2rem]">Period</div>
                  <div className="font-bold">{periodDisplay(settlementDoc.period_start)} → {periodDisplay(settlementDoc.period_end)}</div>
                </div>
                <div className="text-right">
                  <span className={`badge ${statusCls} text-[0.75rem]`}>{settlementDoc.payout_status || 'N/A'}</span>
                  {settlementDoc.payout_utr && (
                    <div className="text-[0.72rem] text-dim mt-[0.2rem]">
                      UTR: <span className="font-mono">{settlementDoc.payout_utr}</span>
                    </div>
                  )}
                  {paidAtDisplay && (
                    <div className="text-[0.72rem] text-dim">Paid: {paidAtDisplay}</div>
                  )}
                </div>
              </div>

              <div className="font-mono text-[0.78rem] leading-[1.9] bg-ink4 rounded-lg py-4 px-[1.2rem] mb-4">
                <BdLine label="Food Revenue" value={settlementDoc.food_revenue_rs} sign="" />
                <BdLine label="Food GST" value={settlementDoc.food_gst_collected_rs} sign="+" />
                <BdLine label="Packaging" value={settlementDoc.packaging_collected_rs} sign="+" />
                <BdLine label="Packaging GST" value={settlementDoc.packaging_gst_rs} sign="+" />
                <BdLine label="Delivery Fee" value={settlementDoc.delivery_fee_collected_rs} sign="+" />
                {DASH}
                <BdTotal label="GROSS" value={settlementDoc.gross_revenue_rs} colorClass="text-acc" />
                {DASH}
                <BdLine label="Platform Fee" value={settlementDoc.platform_fee_rs} sign="-" />
                <BdLine label="Platform Fee GST" value={settlementDoc.platform_fee_gst_rs} sign="-" />
                <BdLine label="Delivery Cost (Absorbed Share)" value={settlementDoc.delivery_fee_restaurant_share_rs} sign="-" />
                <BdLine label="Delivery GST" value={settlementDoc.delivery_fee_restaurant_gst_rs} sign="-" />
                <BdLine label="Discounts" value={settlementDoc.discount_total_rs} sign="-" />
                <BdLine label="Refunds" value={settlementDoc.refund_total_rs} sign="-" />
                <BdLine label="TDS" value={settlementDoc.tds_amount_rs} sign="-" />
                <BdLine label="Referral Fee" value={settlementDoc.referral_fee_rs} sign="-" />
                <BdLine label="Referral GST" value={settlementDoc.referral_fee_gst_rs} sign="-" />
                <BdLine label="Cancellation Penalty Charges" value={settlementDoc.cancellation_fault_fees || 0} sign="-" />
                {DASH}
                <BdTotal label="NET PAYOUT" value={settlementDoc.net_payout_rs} colorClass="text-wa" />
              </div>

              <MetaBreakdown data={meta} />

              <div className="flex gap-2 items-center flex-wrap mb-[0.4rem]">
                <span className="text-[0.72rem] font-bold tracking-[0.08em] uppercase text-mute">
                  Orders in this Settlement{detail.orders ? ` (${detail.orders.length})` : ''}
                </span>
                <select
                  id="fin-set-branch"
                  value={selectedBranchId ?? ''}
                  onChange={(e) => setSelectedBranchId(e.target.value || null)}
                  className="ml-auto text-[0.75rem] py-[0.28rem] px-2 border border-rim rounded-md"
                >
                  <option value="">All Branches</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>

              {selectedBranchId && detail.orders ? (() => {
                const branch = branches.find((b) => b.id === selectedBranchId);
                const branchName = branch?.name || 'Selected branch';
                const count = detail.orders.length;
                const revenueRs = detail.orders.reduce((sum, o) => sum + (Number(o.total_rs) || 0), 0);
                return (
                  <div className="text-[0.78rem] text-dim mb-2">
                    {count} order{count === 1 ? '' : 's'} · {formatINR(revenueRs)} revenue from {branchName} in this settlement.
                  </div>
                );
              })() : null}

              {detail.orders?.length ? (
                <div className="max-h-[200px] overflow-y-auto border border-rim rounded-lg">
                  <table>
                    <thead>
                      <tr>
                        <th>Order #</th>
                        <th>Date</th>
                        <th>Amount</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.orders.map((o, idx) => (
                        <tr key={o._id || o.order_number || idx}>
                          <td className="font-mono text-[0.75rem]">
                            {o.display_order_id || `#${(o._id || '').slice(-6) || '????'}`}
                          </td>
                          <td className="text-[0.78rem]">{periodDisplay(o.delivered_at || o.created_at)}</td>
                          <td>{formatINR(o.total_rs)}</td>
                          <td><span className="badge bg">{o.status || 'Delivered'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-[0.78rem] text-dim py-[0.6rem] px-[0.2rem]">
                  No orders {selectedBranchId ? 'from this branch' : ''} in this settlement.
                </div>
              )}
            </>
          )}
        </div>
        <div className="py-[0.8rem] px-[1.3rem] border-t border-rim flex justify-end gap-2">
          {detail && (
            <button type="button" className="btn-p" disabled={downloading} onClick={handleDownload}>
              {downloading ? 'Preparing…' : '📥 Download Excel'}
            </button>
          )}
          <button type="button" className="btn-g btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
