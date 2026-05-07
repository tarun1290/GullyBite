'use client';

import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import {
  getOrderById,
  getDeliveryStatus,
  dispatchOrder,
  cancelDelivery,
  reportFakeDelivery,
} from '../../api/restaurant';
import { useToast } from '../Toast';
import type { Order, OrderItem } from '../../types';
import DeliveryProofPhotos from '../shared/DeliveryProofPhotos';
import DeliveryTimeline from '../shared/DeliveryTimeline';
import IssueStatusBadge from '../shared/IssueStatusBadge';
import RiderLocationCard from '../restaurant/RiderLocationCard';

// Delivery-status → palette (mirrors statusColors map in legacy orders.js:165).
const DELIVERY_STATUS_COLORS: Record<string, string> = {
  delivered: '#16a34a',
  picked_up: '#2563eb',
  assigned:  '#d97706',
  pending:   '#6b7280',
  failed:    '#dc2626',
  cancelled: '#dc2626',
};

interface DeliveryFeeBreakdown {
  distanceKm?: number | null;
  baseFee?: number | string | null;
  distanceFee?: number | string | null;
  effectiveMultiplier?: number;
  reason?: string;
  capped?: boolean;
}

type LooseItem = OrderItem & {
  id?: string;
  item_name?: string;
  quantity?: number;
  line_total_rs?: number | string;
};

type LooseOrder = Order & {
  items?: LooseItem[];
  food_gst_rs?: number | string | null;
  packaging_rs?: number | string | null;
  packaging_gst_rs?: number | string | null;
  subtotal_rs?: number | string | null;
  customer_delivery_rs?: number | string | null;
  customer_delivery_gst_rs?: number | string | null;
  delivery_fee_rs?: number | string | null;
  delivery_fee_total_rs?: number | string | null;
  discount_rs?: number | string | null;
  coupon_code?: string | null;
  delivery_fee_breakdown?: DeliveryFeeBreakdown | null;
  restaurant_delivery_rs?: number | string | null;
  restaurant_delivery_gst_rs?: number | string | null;
  delivery_address?: string | null;
  delivery_lat?: number | null;
  delivery_lng?: number | null;
};

interface DeliveryStatus {
  status?: string;
  provider?: string;
  driver_name?: string;
  driver_phone?: string;
  estimated_mins?: number;
  cost_rs?: number | string;
  tracking_url?: string;
}

interface DeliveryStatusResponse {
  delivery?: DeliveryStatus | null;
}

function f(n: number | string | null | undefined): string {
  const v = parseFloat(String(n || 0));
  return Number.isFinite(v) ? v.toFixed(2) : '0.00';
}

interface DeliveryDetailLineProps {
  label: string;
  value: number | string | null | undefined;
  bold?: boolean;
}

function DeliveryDetailLine({ label, value, bold }: DeliveryDetailLineProps) {
  return (
    <tr>
      <td className="py-1 text-dim">{label}</td>
      <td className={`text-right ${bold ? 'font-bold' : ''}`}>₹{f(value)}</td>
    </tr>
  );
}

interface ItemsTableProps {
  items?: LooseItem[] | undefined;
}

function ItemsTable({ items }: ItemsTableProps) {
  if (!items?.length) return null;
  return (
    <table className="w-full border-collapse mt-[0.3rem]">
      <tbody>
        {items.map((i, idx) => (
          <tr key={i.id || idx}>
            <td className="py-[0.35rem]">{i.item_name}</td>
            <td className="text-center">×{i.quantity}</td>
            <td className="text-right">₹{f(i.line_total_rs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface ChargeBreakdownProps {
  order: LooseOrder;
}

function ChargeBreakdown({ order }: ChargeBreakdownProps) {
  const hasCharges = order.food_gst_rs != null || order.packaging_rs != null;
  const rows: ReactNode[] = [];
  rows.push(<DeliveryDetailLine key="sub" label="Subtotal" value={order.subtotal_rs} />);

  if (hasCharges) {
    if (parseFloat(String(order.food_gst_rs || 0)) > 0) {
      rows.push(<DeliveryDetailLine key="fgst" label="Food GST (5%)" value={order.food_gst_rs} />);
    }
    if (parseFloat(String(order.customer_delivery_rs || 0)) > 0) {
      rows.push(<DeliveryDetailLine key="cd" label="Delivery" value={order.customer_delivery_rs} />);
      rows.push(<DeliveryDetailLine key="cdg" label="Delivery GST (18%)" value={order.customer_delivery_gst_rs} />);
    } else if (parseFloat(String(order.delivery_fee_rs || 0)) > 0) {
      rows.push(<DeliveryDetailLine key="df" label="Delivery" value={order.delivery_fee_rs} />);
    }
    if (parseFloat(String(order.packaging_rs || 0)) > 0) {
      rows.push(<DeliveryDetailLine key="pk" label="Packaging" value={order.packaging_rs} />);
      if (parseFloat(String(order.packaging_gst_rs || 0)) > 0) {
        rows.push(<DeliveryDetailLine key="pkg" label="Packaging GST" value={order.packaging_gst_rs} />);
      }
    }
  } else {
    rows.push(<DeliveryDetailLine key="df" label="Delivery" value={order.delivery_fee_rs} />);
  }

  if (parseFloat(String(order.discount_rs || 0)) > 0) {
    rows.push(
      <tr key="dis">
        <td className="py-1 text-dim">
          Discount {order.coupon_code ? `(${order.coupon_code})` : ''}
        </td>
        <td className="text-right text-green-600">−₹{f(order.discount_rs)}</td>
      </tr>
    );
  }

  rows.push(
    <tr key="sep">
      <td colSpan={2}>
        <hr className="border-0 border-t border-dashed border-rim2 my-[0.3rem]" />
      </td>
    </tr>
  );
  rows.push(<DeliveryDetailLine key="tot" label="Customer Total" value={order.total_rs} bold />);

  return (
    <table className="w-full border-collapse mt-[0.3rem]">
      <tbody>{rows}</tbody>
    </table>
  );
}

function DynamicPricingNote({ order }: ChargeBreakdownProps) {
  const bd = order.delivery_fee_breakdown;
  if (!bd || bd.distanceKm == null) return null;
  const parts: string[] = [`${bd.distanceKm} km`];
  if (bd.baseFee) parts.push(`Base ₹${bd.baseFee}`);
  if (bd.distanceFee) parts.push(`Distance ₹${bd.distanceFee}`);
  if ((bd.effectiveMultiplier ?? 0) > 1.0) parts.push(`${bd.effectiveMultiplier}x${bd.reason ? ' (' + bd.reason + ')' : ''}`);
  if (bd.capped) parts.push('Capped');
  return (
    <div className="mt-[0.4rem] text-[0.72rem] text-dim">
      ⚡ {parts.join(' · ')}
    </div>
  );
}

function SettlementNote({ order }: ChargeBreakdownProps) {
  if (!(parseFloat(String(order.restaurant_delivery_rs || 0)) > 0)) return null;
  const deduction = parseFloat(String(order.restaurant_delivery_rs || 0)) + parseFloat(String(order.restaurant_delivery_gst_rs || 0));
  return (
    <div className="mt-[0.8rem] py-[0.65rem] px-[0.9rem] bg-[#fef9ec] border border-[#fde68a] rounded-lg text-[0.78rem] text-[#92400e]">
      Settlement deduction: <strong>₹{deduction.toFixed(2)}</strong> (restaurant delivery share + GST)
    </div>
  );
}

interface DeliverySectionProps {
  orderId: string;
  delivery: DeliveryStatus | null;
  // Gross delivery fee captured at checkout (order.delivery_fee_total_rs).
  // Distinct from delivery.cost_rs (the 3PL invoice) — we display the
  // checkout-time fee here so admins see what the customer was charged
  // for delivery, not what the LSP billed us.
  deliveryFeeTotalRs?: number | string | null;
  onDispatch: (id: string) => void | Promise<void>;
  onCancelDelivery: (id: string) => void | Promise<void>;
  busy: boolean;
}

function DeliverySection({ orderId, delivery, deliveryFeeTotalRs, onDispatch, onCancelDelivery, busy }: DeliverySectionProps) {
  if (!delivery) return null;
  const status = delivery.status || 'pending';
  const color = DELIVERY_STATUS_COLORS[status] || '#6b7280';

  return (
    <div className="mt-[0.8rem] py-[0.65rem] px-[0.9rem] bg-ink2 border border-bdr rounded-lg">
      <div className="text-[0.75rem] text-dim mb-[0.4rem]">🚴 Delivery</div>
      <div className="flex gap-[0.8rem] items-center flex-wrap text-[0.82rem]">
        <span
          className="py-[0.15rem] px-2 rounded-sm font-semibold text-[0.75rem]"
          // bg/colour come from DELIVERY_STATUS_COLORS by delivery.status
          // at runtime (delivered/picked_up/.../cancelled — 6 hex). The
          // bg is the same hex with `22` alpha appended for a tint.
          style={{ background: `${color}22`, color }}
        >
          {status.toUpperCase()}
        </span>
        {delivery.provider && <span className="text-dim">{delivery.provider}</span>}
        {delivery.driver_name && <span>👤 {delivery.driver_name}</span>}
        {delivery.driver_phone && (
          <a href={`tel:${delivery.driver_phone}`} className="text-wa">
            📞 {delivery.driver_phone}
          </a>
        )}
        {delivery.estimated_mins && <span>⏱ ~{delivery.estimated_mins} min</span>}
        {deliveryFeeTotalRs != null && parseFloat(String(deliveryFeeTotalRs)) > 0 && (
          <span className="text-dim">₹{parseFloat(String(deliveryFeeTotalRs)).toFixed(0)} 3PL cost</span>
        )}
      </div>
      <div className="mt-2 flex gap-2 flex-wrap">
        {delivery.tracking_url && (
          <a
            href={delivery.tracking_url}
            target="_blank"
            rel="noreferrer"
            className="btn-p btn-sm no-underline text-[0.75rem]"
          >
            📍 Track Delivery
          </a>
        )}
        {(status === 'failed' || status === 'cancelled') && (
          <button
            type="button"
            className="btn-g btn-sm text-[0.75rem]"
            onClick={() => onDispatch(orderId)}
            disabled={busy}
          >
            🔄 Re-dispatch
          </button>
        )}
        {(status === 'assigned' || status === 'picked_up') && (
          <button
            type="button"
            className="btn-del btn-sm"
            onClick={() => onCancelDelivery(orderId)}
            disabled={busy}
          >
            ❌ Cancel Delivery
          </button>
        )}
        {status === 'pending' && (
          <button
            type="button"
            className="btn-p btn-sm text-[0.75rem]"
            onClick={() => onDispatch(orderId)}
            disabled={busy}
          >
            🚴 Dispatch Now
          </button>
        )}
      </div>
    </div>
  );
}

interface OrderDetailModalProps {
  orderId: string;
  onClose: () => void;
  onStatusSync?: () => void;
}

export default function OrderDetailModal({ orderId, onClose, onStatusSync }: OrderDetailModalProps) {
  const { showToast } = useToast();
  const [order, setOrder] = useState<LooseOrder | null>(null);
  const [delivery, setDelivery] = useState<DeliveryStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [confirmCancelDelivery, setConfirmCancelDelivery] = useState<boolean>(false);
  const [timelineOpen, setTimelineOpen] = useState<boolean>(false);

  const fetchAll = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    setError(null);
    try {
      const o = (await getOrderById(orderId)) as LooseOrder | null;
      if (!o) {
        setError('Order not found.');
        return;
      }
      setOrder(o);
      try {
        const dRes = (await getDeliveryStatus(orderId)) as DeliveryStatusResponse | null | undefined;
        setDelivery(dRes?.delivery || null);
      } catch (_e) {
        setDelivery(null);
      }
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      setError(e?.userMessage || e?.message || 'Could not load order');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Esc closes the modal — matches legacy's click-outside dismissal behavior.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleDispatch = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await dispatchOrder(id);
      showToast('Delivery dispatched ✓', 'success');
      await fetchAll();
      onStatusSync?.();
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      showToast(e?.userMessage || e?.message || 'Dispatch failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleReportFakeDelivery = async () => {
    if (busy || !order) return;
    if (!window.confirm('Report this delivery as fake? This raises a formal dispute with the 3PL and cannot be undone.')) {
      return;
    }
    setBusy(true);
    try {
      const result = await reportFakeDelivery(orderId);
      showToast(`Dispute raised — issue ${result.issue_id}`, 'success');
      await fetchAll();
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string } }; userMessage?: string; message?: string };
      const msg = e?.response?.data?.error || e?.userMessage || e?.message || 'Could not raise dispute';
      showToast(msg, e?.response?.status === 409 ? 'warning' : 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelDelivery = async (id: string) => {
    if (!confirmCancelDelivery) {
      setConfirmCancelDelivery(true);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      await cancelDelivery(id);
      showToast('Delivery cancelled', 'success');
      setConfirmCancelDelivery(false);
      await fetchAll();
      onStatusSync?.();
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      showToast(e?.userMessage || e?.message || 'Cancel failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Restaurant-facing label per the order-id-display policy: never expose
  // the legacy ZM-YYYYMMDD-NNNN. Prefer `display_order_id`; fall back to a
  // 6-char slice of the internal UUID for orders predating the rollout.
  const orderRef = order
    ? (order.display_order_id || `#${(order.id || '').slice(-6) || '????'}`)
    : '';
  const title = order ? `Order ${orderRef}` : 'Order Detail';
  const customerSecondary = order?.wa_phone || (order?.bsuid ? `${String(order.bsuid).slice(0, 12)}…` : '');

  return (
    <div
      id="ord-modal"
      onClick={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onClose?.(); }}
      className="fixed inset-0 bg-[rgba(15,23,42,0.55)] backdrop-blur-xs z-200 flex items-center justify-center p-6"
    >
      <div className="bg-white border border-rim rounded-[14px] w-full max-w-[520px] overflow-hidden shadow-default">
        <div className="py-[1.1rem] px-[1.3rem] border-b border-rim flex items-center justify-between">
          <span id="ord-modal-title" className="font-bold text-[0.95rem] text-tx">
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="bg-none border-0 text-dim text-[1.1rem] cursor-pointer"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div
          id="ord-modal-body"
          className="p-[1.3rem] max-h-[70vh] overflow-y-auto text-[0.84rem]"
        >
          {loading && (
            <div className="text-center p-8 text-dim">Loading…</div>
          )}
          {error && !loading && (
            <div className="p-4 text-center">
              <p className="text-red">{error}</p>
              <button type="button" className="btn-g btn-sm" onClick={fetchAll}>Retry</button>
            </div>
          )}
          {order && !loading && !error && (
            <>
              <div className="mb-[0.8rem]">
                <span className="text-[0.75rem] text-dim">Customer</span>
                <div className="font-semibold">
                  {order.customer_name || '—'} · {customerSecondary}
                </div>
                {order.delivery_address ? (
                  <div className="text-[0.75rem] text-dim mt-[0.2rem]">
                    📍 {order.delivery_address}
                  </div>
                ) : (order.delivery_lat && order.delivery_lng) ? (
                  <div className="text-[0.75rem] mt-[0.2rem]">
                    <a
                      href={`https://www.google.com/maps?q=${order.delivery_lat},${order.delivery_lng}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-acc no-underline"
                    >
                      📍 View on Maps
                    </a>
                  </div>
                ) : null}
              </div>

              <div className="mb-[0.8rem]">
                <span className="text-[0.75rem] text-dim">Items</span>
                <ItemsTable items={order.items} />
              </div>

              <div>
                <span className="text-[0.75rem] text-dim">Charge Breakdown</span>
                <ChargeBreakdown order={order} />
              </div>

              <DynamicPricingNote order={order} />
              <SettlementNote order={order} />

              <DeliverySection
                orderId={orderId}
                delivery={delivery}
                deliveryFeeTotalRs={order.delivery_fee_total_rs}
                onDispatch={handleDispatch}
                onCancelDelivery={handleCancelDelivery}
                busy={busy}
              />

              {(delivery?.status === 'assigned' || delivery?.status === 'picked_up') && (
                <RiderLocationCard orderId={orderId} />
              )}

              {order.prorouting_state && (
                <div className="mt-[0.6rem] border border-rim rounded-lg bg-ink2 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setTimelineOpen((v) => !v)}
                    aria-expanded={timelineOpen}
                    className="w-full bg-none border-0 py-[0.55rem] px-[0.8rem] flex items-center gap-2 cursor-pointer text-[0.8rem] font-semibold text-tx"
                  >
                    <span
                      aria-hidden
                      className={`inline-block transition-transform duration-150 ease-in-out text-[0.7rem] text-dim ${timelineOpen ? 'rotate-90' : 'rotate-0'}`}
                    >
                      ▶
                    </span>
                    Delivery Timeline
                  </button>
                  {timelineOpen && (
                    <div className="pt-[0.4rem] pr-[0.9rem] pb-[0.8rem] pl-[1.6rem]">
                      <DeliveryTimeline order={order} />
                    </div>
                  )}
                </div>
              )}

              <div className="mt-[0.6rem]">
                <DeliveryProofPhotos
                  pickupProof={order.prorouting_pickup_proof}
                  deliveryProof={order.prorouting_delivery_proof}
                />
              </div>

              <IssueStatusBadge
                issueId={order.prorouting_issue_id}
                raisedAt={order.prorouting_issue_raised_at}
              />

              {order.status === 'DELIVERED' && !order.prorouting_issue_id && (
                <div className="mt-[0.6rem]">
                  <button
                    type="button"
                    className="btn-del btn-sm text-[0.78rem]"
                    onClick={handleReportFakeDelivery}
                    disabled={busy}
                  >
                    {busy ? '…' : '⚠ Report Fake Delivery'}
                  </button>
                </div>
              )}

              {confirmCancelDelivery && (
                <div className="mt-[0.6rem] py-[0.65rem] px-[0.9rem] bg-[#fef2f2] border border-[#fecaca] rounded-lg text-[0.8rem] text-[#991b1b] flex items-center justify-between gap-[0.6rem] flex-wrap">
                  <span>Cancel the active delivery?</span>
                  <div className="flex gap-[0.4rem]">
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() => setConfirmCancelDelivery(false)}
                      disabled={busy}
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      className="btn-del btn-sm"
                      onClick={() => handleCancelDelivery(orderId)}
                      disabled={busy}
                    >
                      {busy ? (<><span className="spin" /> …</>) : 'Yes, cancel'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
