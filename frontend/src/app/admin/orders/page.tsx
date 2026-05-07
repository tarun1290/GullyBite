'use client';

import type { ChangeEvent } from 'react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import DeliveryProofPhotos from '../../../components/shared/DeliveryProofPhotos';
import DeliveryTimeline from '../../../components/shared/DeliveryTimeline';
import IssueStatusBadge from '../../../components/shared/IssueStatusBadge';
import { useToast } from '../../../components/Toast';
import { getAdminOrders, reportFakeDeliveryAdmin } from '../../../api/admin';

const ORDERS_LIMIT = 50;

interface StatusOption { value: string; label: string }

const STATUS_OPTIONS: ReadonlyArray<StatusOption> = [
  { value: '', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'PREPARING', label: 'Preparing' },
  { value: 'PACKED', label: 'Packed' },
  { value: 'DISPATCHED', label: 'Dispatched' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const STATUS_COLOR: Record<string, string> = {
  PENDING: '#f59e0b',
  CONFIRMED: '#3b82f6',
  PREPARING: '#8b5cf6',
  PACKED: 'var(--gb-indigo-500)',
  DISPATCHED: '#0ea5e9',
  DELIVERED: 'var(--gb-wa-500)',
  CANCELLED: 'var(--gb-red-500)',
};

interface AdminOrderRow {
  _id?: string;
  order_number?: string;
  display_order_id?: string;
  business_name?: string;
  branch_name?: string;
  wa_phone?: string;
  bsuid?: string;
  total_rs?: number;
  status?: string;
  created_at?: string;
  // Prorouting (3PL) proof URLs — populated by the status-callback handler
  // on delivered/RTO orders. Surfaced via DeliveryProofPhotos in the row.
  // The /api/admin/orders endpoint returns the full order doc unprojected,
  // so these fields are present in the response when persisted.
  prorouting_pickup_proof?: string;
  prorouting_delivery_proof?: string;
  // Prorouting state + per-state timestamps. Powers the inline
  // DeliveryTimeline expansion — admins reconcile RTO orders by walking
  // these stamps. Same source as the order detail modal on the
  // restaurant side; kept name-for-name aligned with the Order type.
  prorouting_state?: string;
  prorouting_assigned_at?: string;
  prorouting_pickedup_at?: string;
  prorouting_delivered_at?: string;
  prorouting_at_pickup_at?: string;
  prorouting_at_delivery_at?: string;
  prorouting_rto_initiated_at?: string;
  prorouting_rto_delivered_at?: string;
  prorouting_cancelled_at?: string;
  // Prorouting dispute (fake-delivery, wrong-item, damage). Surfaced
  // inline next to the DeliveryTimeline; admins can also raise FLM08
  // disputes from here on behalf of restaurants.
  prorouting_issue_id?: string;
  prorouting_issue_raised_at?: string;
}

interface AdminOrdersResponse {
  total?: number;
  orders?: AdminOrderRow[];
}

interface StatusBadgeProps { status?: string }

function StatusBadge({ status }: StatusBadgeProps) {
  const bg = STATUS_COLOR[status || ''] || 'var(--gb-slate-500)';
  return (
    <span
      className="text-neutral-0 text-[0.68rem] font-bold py-[0.1rem] px-[0.45rem] rounded-sm uppercase tracking-[0.04em]"
      // background colour comes from STATUS_COLOR by status at runtime
      // (PENDING/CONFIRMED/PREPARING/PACKED/DISPATCHED/DELIVERED/CANCELLED
      // — 7 distinct values plus a slate-500 fallback).
      style={{ background: bg }}
    >{status || '—'}</span>
  );
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

function customerLabel(o: AdminOrderRow): string {
  if (o.wa_phone) return o.wa_phone;
  if (o.bsuid) return `${String(o.bsuid).slice(0, 12)}…`;
  return '—';
}

const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.6rem] px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const SEL_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.3rem] px-[0.55rem] text-[0.78rem]';

export default function AdminOrdersPage() {
  const { showToast } = useToast();
  const [status, setStatus] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [offset, setOffset] = useState<number>(0);

  const [data, setData] = useState<AdminOrdersResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  // Per-row timeline expansion. Set of order ids whose Delivery Timeline
  // detail row is currently visible. Cleared on filter change implicitly
  // — when `data` reloads, ids that no longer appear in `orders` simply
  // never render their detail row, so leaving stale ids in the set is
  // harmless and saves a manual reset.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Per-row "Report Fake Delivery" busy state. Tracked as a Set rather
  // than a single boolean so an admin can fire two reports back-to-back
  // on different orders without the second click being blocked while
  // the first is still in flight. Cleared on the row-level await.
  const [reporting, setReporting] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const params: Record<string, string | number> = { limit: ORDERS_LIMIT, offset };
    if (status) params.status = status;
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = `${dateTo}T23:59:59`;
    try {
      const d = (await getAdminOrders(params)) as AdminOrdersResponse | null;
      setData(d || null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [status, dateFrom, dateTo, offset]);

  useEffect(() => { load(); }, [load]);

  const handleReportFakeDelivery = useCallback(async (id: string) => {
    if (!id || reporting.has(id)) return;
    if (!window.confirm('Report this delivery as fake on behalf of the restaurant? This raises a formal dispute with the 3PL and cannot be undone.')) {
      return;
    }
    setReporting((prev) => new Set(prev).add(id));
    try {
      const result = await reportFakeDeliveryAdmin(id);
      showToast(`Dispute raised — issue ${result.issue_id}`, 'success');
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string } }; message?: string };
      const msg = e?.response?.data?.error || e?.message || 'Could not raise dispute';
      showToast(msg, e?.response?.status === 409 ? 'warning' : 'error');
    } finally {
      setReporting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [reporting, showToast, load]);

  const total = data?.total ?? 0;
  const orders = data?.orders ?? [];
  const page = Math.floor(offset / ORDERS_LIMIT) + 1;
  const pages = Math.ceil(total / ORDERS_LIMIT) || 1;

  const onFilterChange = (setter: (v: string) => void) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { setter(e.target.value); setOffset(0); };
  const clearFilters = () => { setStatus(''); setDateFrom(''); setDateTo(''); setOffset(0); };

  return (
    <div id="pg-orders">
      <div className="card">
        <div className="ch gap-[0.6rem] flex-wrap">
          <h3>All Orders</h3>
          <span className="text-dim text-[0.75rem]">
            {loading ? '' : `${total} total`}
          </span>
          <button type="button" className="btn-g btn-sm ml-auto" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>

        <div className="cb flex gap-[0.6rem] flex-wrap items-center border-b border-rim">
          <span className="text-[0.74rem] text-dim">Status:</span>
          <select value={status} onChange={onFilterChange(setStatus)} className={SEL_CLS}>
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input type="date" value={dateFrom} onChange={onFilterChange(setDateFrom)} className={SEL_CLS} />
          <input type="date" value={dateTo} onChange={onFilterChange(setDateTo)} className={SEL_CLS} />
          <button type="button" className="btn-g btn-sm" onClick={clearFilters}>Clear</button>
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={`${TH_CLS} w-7`} aria-label="Expand timeline" />
                  <th className={TH_CLS}>Order #</th>
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Branch</th>
                  <th className={TH_CLS}>Customer</th>
                  <th className={TH_CLS}>Total</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Time</th>
                  <th className={TH_CLS}>Proofs</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={9} className={EMPTY_CLS}>Loading…</td></tr>
                ) : orders.length === 0 ? (
                  <tr><td colSpan={9} className={EMPTY_CLS}>No orders found</td></tr>
                ) : (
                  orders.map((o) => {
                    const id = o._id || String(o.order_number || '');
                    const isOpen = id ? expanded.has(id) : false;
                    const hasTimeline = !!o.prorouting_state;
                    return (
                      <Fragment key={id || o.order_number}>
                        <tr className={isOpen ? 'border-b-0' : 'border-b border-rim'}>
                          <td className="py-[0.4rem] pr-[0.3rem] pl-[0.7rem] align-top">
                            {hasTimeline ? (
                              <button
                                type="button"
                                onClick={() => toggleExpanded(id)}
                                aria-expanded={isOpen}
                                aria-label={isOpen ? 'Hide delivery timeline' : 'Show delivery timeline'}
                                className={`bg-none border-0 py-[0.15rem] px-[0.3rem] cursor-pointer text-dim text-[0.7rem] leading-none transition-transform duration-150 ease-in-out ${isOpen ? 'rotate-90' : 'rotate-0'}`}
                              >
                                ▶
                              </button>
                            ) : null}
                          </td>
                          <td className={TD_CLS}>
                            {o.display_order_id ? (
                              <>
                                <div className="mono">{o.display_order_id}</div>
                                {o.order_number && (
                                  <div className="text-[0.68rem] text-mute font-mono">
                                    {o.order_number}
                                  </div>
                                )}
                              </>
                            ) : (
                              <span className="mono">#{o.order_number || '—'}</span>
                            )}
                          </td>
                          <td className={TD_CLS}>{o.business_name || '—'}</td>
                          <td className={TD_CLS}>{o.branch_name || '—'}</td>
                          <td className={`${TD_CLS} text-[0.76rem] mono`}>
                            {customerLabel(o)}
                          </td>
                          <td className={TD_CLS}><strong>₹{o.total_rs}</strong></td>
                          <td className={TD_CLS}><StatusBadge status={o.status} /></td>
                          <td className={`${TD_CLS} text-dim text-[0.74rem]`}>
                            {fmtTime(o.created_at)}
                          </td>
                          <td className={TD_CLS}>
                            <DeliveryProofPhotos
                              pickupProof={o.prorouting_pickup_proof}
                              deliveryProof={o.prorouting_delivery_proof}
                              size={64}
                              layout="vertical"
                            />
                          </td>
                        </tr>
                        {isOpen && hasTimeline && (
                          <tr className="border-b border-rim bg-ink2">
                            <td />
                            <td colSpan={8} className="pt-[0.6rem] pr-4 pb-4 pl-4">
                              <div className="text-[0.74rem] text-dim mb-[0.3rem] font-semibold">
                                Delivery Timeline
                              </div>
                              <DeliveryTimeline order={o} />
                              <IssueStatusBadge
                                issueId={o.prorouting_issue_id}
                                raisedAt={o.prorouting_issue_raised_at}
                              />
                              {o.status === 'DELIVERED' && !o.prorouting_issue_id && (
                                <div className="mt-[0.6rem]">
                                  <button
                                    type="button"
                                    className="btn-del btn-sm text-[0.78rem]"
                                    onClick={() => handleReportFakeDelivery(id)}
                                    disabled={reporting.has(id)}
                                  >
                                    {reporting.has(id) ? '…' : '⚠ Report Fake Delivery'}
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        <div className="py-[0.7rem] px-4 flex gap-[0.6rem] items-center border-t border-rim">
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => setOffset(Math.max(0, offset - ORDERS_LIMIT))}
            disabled={loading || offset === 0}
          >← Prev</button>
          <span className="text-[0.78rem] text-dim">
            Page {page} / {pages}
          </span>
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={() => setOffset(offset + ORDERS_LIMIT)}
            disabled={loading || offset + ORDERS_LIMIT >= total}
          >Next →</button>
          <span className="ml-auto text-[0.78rem] text-dim">
            {total} orders
          </span>
        </div>
      </div>
    </div>
  );
}
