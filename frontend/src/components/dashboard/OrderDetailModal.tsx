'use client';

import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import {
  getOrderById,
  getDeliveryStatus,
  dispatchOrder,
  cancelDelivery,
} from '../../api/restaurant';
import { useToast } from '../Toast';
import type { Order, OrderItem } from '../../types';

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
      <td style={{ padding: '.25rem 0', color: 'var(--dim)' }}>{label}</td>
      <td style={{ textAlign: 'right', fontWeight: bold ? 700 : undefined }}>₹{f(value)}</td>
    </tr>
  );
}

interface ItemsTableProps {
  items?: LooseItem[] | undefined;
}

function ItemsTable({ items }: ItemsTableProps) {
  if (!items?.length) return null;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '.3rem' }}>
      <tbody>
        {items.map((i, idx) => (
          <tr key={i.id || idx}>
            <td style={{ padding: '.35rem 0' }}>{i.item_name}</td>
            <td style={{ textAlign: 'center' }}>×{i.quantity}</td>
            <td style={{ textAlign: 'right' }}>₹{f(i.line_total_rs)}</td>
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
        <td style={{ padding: '.25rem 0', color: 'var(--dim)' }}>
          Discount {order.coupon_code ? `(${order.coupon_code})` : ''}
        </td>
        <td style={{ textAlign: 'right', color: '#16a34a' }}>−₹{f(order.discount_rs)}</td>
      </tr>
    );
  }

  rows.push(
    <tr key="sep">
      <td colSpan={2}>
        <hr style={{ border: 'none', borderTop: '1px dashed var(--rim2)', margin: '.3rem 0' }} />
      </td>
    </tr>
  );
  rows.push(<DeliveryDetailLine key="tot" label="Customer Total" value={order.total_rs} bold />);

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '.3rem' }}>
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
    <div style={{ marginTop: '.4rem', fontSize: '.72rem', color: 'var(--dim)' }}>
      ⚡ {parts.join(' · ')}
    </div>
  );
}

function SettlementNote({ order }: ChargeBreakdownProps) {
  if (!(parseFloat(String(order.restaurant_delivery_rs || 0)) > 0)) return null;
  const deduction = parseFloat(String(order.restaurant_delivery_rs || 0)) + parseFloat(String(order.restaurant_delivery_gst_rs || 0));
  return (
    <div
      style={{
        marginTop: '.8rem', padding: '.65rem .9rem',
        background: '#fef9ec', border: '1px solid #fde68a',
        borderRadius: 8, fontSize: '.78rem', color: '#92400e',
      }}
    >
      Settlement deduction: <strong>₹{deduction.toFixed(2)}</strong> (restaurant delivery share + GST)
    </div>
  );
}

interface DeliverySectionProps {
  orderId: string;
  delivery: DeliveryStatus | null;
  onDispatch: (id: string) => void | Promise<void>;
  onCancelDelivery: (id: string) => void | Promise<void>;
  busy: boolean;
}

function DeliverySection({ orderId, delivery, onDispatch, onCancelDelivery, busy }: DeliverySectionProps) {
  if (!delivery) return null;
  const status = delivery.status || 'pending';
  const color = DELIVERY_STATUS_COLORS[status] || '#6b7280';

  return (
    <div
      style={{
        marginTop: '.8rem', padding: '.65rem .9rem',
        background: 'var(--ink2)', border: '1px solid var(--bdr)',
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginBottom: '.4rem' }}>🚴 Delivery</div>
      <div style={{ display: 'flex', gap: '.8rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '.82rem' }}>
        <span
          style={{
            background: `${color}22`, color,
            padding: '.15rem .5rem', borderRadius: 4, fontWeight: 600, fontSize: '.75rem',
          }}
        >
          {status.toUpperCase()}
        </span>
        {delivery.provider && <span style={{ color: 'var(--dim)' }}>{delivery.provider}</span>}
        {delivery.driver_name && <span>👤 {delivery.driver_name}</span>}
        {delivery.driver_phone && (
          <a href={`tel:${delivery.driver_phone}`} style={{ color: 'var(--wa)' }}>
            📞 {delivery.driver_phone}
          </a>
        )}
        {delivery.estimated_mins && <span>⏱ ~{delivery.estimated_mins} min</span>}
        {delivery.cost_rs && (
          <span style={{ color: 'var(--dim)' }}>₹{parseFloat(String(delivery.cost_rs)).toFixed(0)} 3PL cost</span>
        )}
      </div>
      <div style={{ marginTop: '.5rem', display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
        {delivery.tracking_url && (
          <a
            href={delivery.tracking_url}
            target="_blank"
            rel="noreferrer"
            className="btn-p btn-sm"
            style={{ textDecoration: 'none', fontSize: '.75rem' }}
          >
            📍 Track Delivery
          </a>
        )}
        {(status === 'failed' || status === 'cancelled') && (
          <button
            type="button"
            className="btn-g btn-sm"
            style={{ fontSize: '.75rem' }}
            onClick={() => onDispatch(orderId)}
            disabled={busy}
          >
            🔄 Re-dispatch
          </button>
        )}
        {(status === 'assigned' || status === 'picked_up') && (
          <button
            type="button"
            className="btn-sm"
            style={{
              fontSize: '.75rem',
              background: '#fee2e2', color: '#b91c1c',
              border: '1px solid #fca5a5', borderRadius: 4, cursor: 'pointer',
            }}
            onClick={() => onCancelDelivery(orderId)}
            disabled={busy}
          >
            ❌ Cancel Delivery
          </button>
        )}
        {status === 'pending' && (
          <button
            type="button"
            className="btn-p btn-sm"
            style={{ fontSize: '.75rem' }}
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

  const title = order ? `Order #${order.order_number}` : 'Order Detail';
  const customerSecondary = order?.wa_phone || (order?.bsuid ? `${String(order.bsuid).slice(0, 12)}…` : '');

  return (
    <div
      id="ord-modal"
      onClick={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(15,23,42,.55)',
        backdropFilter: 'blur(4px)',
        zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1.5rem',
      }}
    >
      <div
        style={{
          background: '#fff', border: '1px solid var(--rim)',
          borderRadius: 14, width: '100%', maxWidth: 520,
          overflow: 'hidden',
          boxShadow: 'var(--shadow)',
        }}
      >
        <div
          style={{
            padding: '1.1rem 1.3rem', borderBottom: '1px solid var(--rim)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <span id="ord-modal-title" style={{ fontWeight: 700, fontSize: '.95rem', color: 'var(--tx)' }}>
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--dim)', fontSize: '1.1rem', cursor: 'pointer' }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div
          id="ord-modal-body"
          style={{ padding: '1.3rem', maxHeight: '70vh', overflowY: 'auto', fontSize: '.84rem' }}
        >
          {loading && (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--dim)' }}>Loading…</div>
          )}
          {error && !loading && (
            <div style={{ padding: '1rem', textAlign: 'center' }}>
              <p style={{ color: 'var(--red)' }}>{error}</p>
              <button type="button" className="btn-g btn-sm" onClick={fetchAll}>Retry</button>
            </div>
          )}
          {order && !loading && !error && (
            <>
              <div style={{ marginBottom: '.8rem' }}>
                <span style={{ fontSize: '.75rem', color: 'var(--dim)' }}>Customer</span>
                <div style={{ fontWeight: 600 }}>
                  {order.customer_name || '—'} · {customerSecondary}
                </div>
                {order.delivery_address ? (
                  <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginTop: '.2rem' }}>
                    📍 {order.delivery_address}
                  </div>
                ) : (order.delivery_lat && order.delivery_lng) ? (
                  <div style={{ fontSize: '.75rem', marginTop: '.2rem' }}>
                    <a
                      href={`https://www.google.com/maps?q=${order.delivery_lat},${order.delivery_lng}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--acc)', textDecoration: 'none' }}
                    >
                      📍 View on Maps
                    </a>
                  </div>
                ) : null}
              </div>

              <div style={{ marginBottom: '.8rem' }}>
                <span style={{ fontSize: '.75rem', color: 'var(--dim)' }}>Items</span>
                <ItemsTable items={order.items} />
              </div>

              <div>
                <span style={{ fontSize: '.75rem', color: 'var(--dim)' }}>Charge Breakdown</span>
                <ChargeBreakdown order={order} />
              </div>

              <DynamicPricingNote order={order} />
              <SettlementNote order={order} />

              <DeliverySection
                orderId={orderId}
                delivery={delivery}
                onDispatch={handleDispatch}
                onCancelDelivery={handleCancelDelivery}
                busy={busy}
              />

              {confirmCancelDelivery && (
                <div
                  style={{
                    marginTop: '.6rem', padding: '.65rem .9rem',
                    background: '#fef2f2', border: '1px solid #fecaca',
                    borderRadius: 8, fontSize: '.8rem', color: '#991b1b',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.6rem', flexWrap: 'wrap',
                  }}
                >
                  <span>Cancel the active delivery?</span>
                  <div style={{ display: 'flex', gap: '.4rem' }}>
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
                      className="btn-sm"
                      style={{
                        background: '#dc2626', color: '#fff', border: 'none',
                        borderRadius: 4, padding: '.3rem .7rem', cursor: 'pointer',
                      }}
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
