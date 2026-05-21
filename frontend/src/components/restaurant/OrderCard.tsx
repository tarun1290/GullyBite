'use client';

import { useState } from 'react';
import { acceptOrder, declineOrder } from '../../api/restaurant';
import type { Order, OrderStatus } from '../../types';

// Status → [badge class, label]. Mirrors sbadge() in legacy orders.js:33-50.
// EXPIRED (`bd`, dim) is missed-sale (no capture). EXPIRED_PAYMENT (`br`,
// red) is captured-then-refunded — distinct money-back terminal; visually
// related to CANCELLED/PAYMENT_FAILED via the shared `br` family, but the
// label disambiguates.
const STATUS_BADGE: Record<string, [string, string]> = {
  PENDING_PAYMENT: ['ba', 'Pending Payment'],
  PAYMENT_FAILED:  ['br', 'Payment Failed'],
  EXPIRED:         ['bd', 'Expired'],
  EXPIRED_PAYMENT: ['br', 'Refunded (expired)'],
  PAID:            ['bb', 'Paid'],
  CONFIRMED:       ['bg', 'Confirmed'],
  PREPARING:       ['ba', 'Preparing'],
  PACKED:          ['bb', 'Packed'],
  DISPATCHED:      ['bv', 'Dispatched'],
  DELIVERED:       ['bg', 'Delivered'],
  CANCELLED:       ['br', 'Cancelled'],
  REJECTED_BY_RESTAURANT: ['br', 'Rejected'],
  PAID_OUT:        ['bg', 'Paid Out'],
  PENDING:         ['ba', 'Pending'],
};

// PREPARING → PACKED stays as a manual click — the kitchen signals when
// packing is done. PAID → CONFIRMED is no longer driven through this
// map; the PAID row has dedicated Accept/Decline buttons below that
// call the /accept and /decline endpoints directly. CONFIRMED is
// intentionally absent so no "Prep" button appears on the owner
// dashboard; the staff app retains its own explicit prep control. Later
// statuses (PACKED → DISPATCHED, DELIVERED) flow through the dispatch
// path.
const NEXT_STATUS: Record<string, [string, string]> = {
  PREPARING: ['PACKED', '📦 Packed'],
};

const ACTIVE_ETA_STATUSES = new Set<string>(['PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED']);

// Row left-accent class by status, mirroring the badge color family. Lets
// the operator scan the orders table by color before reading the badge
// text. Tailwind v4 arbitrary-value classes pull the project's CSS-var
// palette directly (same pattern as bg-[var(--acc-glow)] elsewhere) —
// each value is a static string literal so JIT picks it up. Replaces an
// inline style={{}} on the row.
const STATUS_ROW_BORDER_CLS: Record<string, string> = {
  PENDING_PAYMENT: 'border-l-[3px] border-l-[var(--gold)]',
  PREPARING:       'border-l-[3px] border-l-[var(--gold)]',
  PAYMENT_FAILED:  'border-l-[3px] border-l-[var(--red)]',
  CANCELLED:       'border-l-[3px] border-l-[var(--red)]',
  REJECTED_BY_RESTAURANT: 'border-l-[3px] border-l-[var(--red)]',
  EXPIRED:         'border-l-[3px] border-l-[var(--mute)]',
  EXPIRED_PAYMENT: 'border-l-[3px] border-l-[var(--red)]',
  PAID:            'border-l-[3px] border-l-[var(--blue)]',
  PACKED:          'border-l-[3px] border-l-[var(--blue)]',
  CONFIRMED:       'border-l-[3px] border-l-[var(--wa)]',
  DELIVERED:       'border-l-[3px] border-l-[var(--wa)]',
  PAID_OUT:        'border-l-[3px] border-l-[var(--wa)]',
  DISPATCHED:      'border-l-[3px] border-l-[var(--gb-teal-700)]',
};

interface StatusBadgeProps {
  status?: OrderStatus | string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const fallback: [string, string] = ['bd', String(status || '').replace(/_/g, ' ')];
  const [cls, label] = STATUS_BADGE[String(status || '')] || fallback;
  return <span className={`badge ${cls}`}>{label}</span>;
}

interface EtaCellProps {
  order: Order;
}

function EtaCell({ order }: EtaCellProps) {
  if (order.status === 'DELIVERED') {
    if (order.created_at && order.delivered_at) {
      const mins = Math.round((new Date(order.delivered_at).getTime() - new Date(order.created_at).getTime()) / 60000);
      return <span className="text-wa">Delivered in {mins} min</span>;
    }
    return <span className="text-wa">Delivered</span>;
  }
  if (ACTIVE_ETA_STATUSES.has(order.status) && order.eta_text) {
    return <span className="text-gold font-semibold">⏱ {order.eta_text}</span>;
  }
  return <span className="text-mute">—</span>;
}

function timeAgo(ts?: string): string {
  if (!ts) return '—';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.max(0, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function customerSecondary(order: Order): string {
  if (order.wa_phone) return order.wa_phone;
  if (order.bsuid) return `${String(order.bsuid).slice(0, 12)}…`;
  return '';
}

function extractErrorMessage(e: unknown, fallback: string): string {
  const err = e as { response?: { data?: { error?: string } }; message?: string };
  return err?.response?.data?.error || err?.message || fallback;
}

interface OrderCardProps {
  order: Order;
  // Generic forward transitions (PREPARING → PACKED, etc.). PAID is
  // handled by the inline Accept/Decline buttons below, which hit
  // /accept and /decline directly — onStatusChange is not used for PAID.
  onStatusChange?: (id: string, nextStatus: string) => void | Promise<void>;
  onDispatch?: (id: string) => void | Promise<void>;
  onViewDetail?: (id: string) => void;
  // Optional success notifications fired AFTER the card's direct
  // /accept / /decline call resolves. The parent uses these to silence
  // the new-order alarm and trigger a silent refetch — the API call
  // itself has already happened in the card.
  onAccepted?: (id: string) => void | Promise<void>;
  onDeclined?: (id: string, refundId?: string | null) => void | Promise<void>;
  busy?: boolean;
}

export default function OrderCard({
  order,
  onStatusChange,
  onViewDetail,
  onAccepted,
  onDeclined,
  busy = false,
}: OrderCardProps) {
  // Local status override — set the moment /accept or /decline succeeds
  // so the badge + buttons reflect the new state without waiting for the
  // parent's silent refetch round-trip.
  const [overrideStatus, setOverrideStatus] = useState<OrderStatus | null>(null);
  const [actionInFlight, setActionInFlight] = useState<'accept' | 'decline' | 'next' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const effectiveStatus = overrideStatus || order.status;
  const next = NEXT_STATUS[effectiveStatus];
  const disabled = busy || actionInFlight !== null;

  const handleNextStatus = async () => {
    if (disabled || !next) return;
    setErrorMsg(null);
    setActionInFlight('next');
    try {
      await onStatusChange?.(order.id, next[0]);
    } finally {
      setActionInFlight(null);
    }
  };

  const handleAccept = async () => {
    if (disabled) return;
    setErrorMsg(null);
    setActionInFlight('accept');
    try {
      // /accept returns 200 with { confirmed, alreadyAcknowledged?, status }
      // on the happy + idempotent paths, or HTTP 409 on a state-guard
      // race (axios throws → caught below). The returned `status` is
      // the actual post-acceptance status ('PREPARING' on the normal
      // server-side auto-advance, 'CONFIRMED' if the auto-advance
      // failed). Trust it rather than hard-coding so the badge reflects
      // the real state before the parent's refetch lands.
      const res = await acceptOrder(order.id);
      const reportedStatus = (res?.status as OrderStatus | undefined) || 'CONFIRMED';
      setOverrideStatus(reportedStatus);
      // Parent silences the new-order alarm + refetches silently.
      // Awaited so a thrown parent handler surfaces as an inline error
      // rather than getting lost.
      await onAccepted?.(order.id);
    } catch (e: unknown) {
      setErrorMsg(extractErrorMessage(e, 'Accept failed'));
    } finally {
      setActionInFlight(null);
    }
  };

  const handleDecline = async () => {
    if (disabled) return;
    if (!window.confirm('Decline this order? Customer will be refunded automatically.')) return;
    setErrorMsg(null);
    setActionInFlight('decline');
    try {
      const res = await declineOrder(order.id);
      setOverrideStatus('REJECTED_BY_RESTAURANT');
      await onDeclined?.(order.id, res?.refundId);
    } catch (e: unknown) {
      setErrorMsg(extractErrorMessage(e, 'Decline failed'));
    } finally {
      setActionInFlight(null);
    }
  };

  const rowBorderCls = STATUS_ROW_BORDER_CLS[effectiveStatus] || '';
  const isPaid = effectiveStatus === 'PAID';

  return (
    // Left-border colour comes from STATUS_ROW_BORDER_CLS by effective
    // status (gold/red/mute/blue/wa/teal — 7 distinct CSS vars).
    // Static-literal arbitrary-value classes so Tailwind v4 JIT picks
    // them up.
    <tr className={rowBorderCls}>
      <td><span className="mono">{order.display_order_id || `#${(order.id || '').slice(-6) || '????'}`}</span></td>
      <td>
        <div>{order.customer_name || '—'}</div>
        <div className="text-xs text-dim">
          {customerSecondary(order)}
        </div>
      </td>
      <td>{order.branch_name || ''}</td>
      <td>₹{order.total_rs}</td>
      <td><StatusBadge status={effectiveStatus} /></td>
      <td className="text-xs"><EtaCell order={{ ...order, status: effectiveStatus }} /></td>
      <td className="text-xs text-dim">{timeAgo(order.created_at)}</td>
      <td>
        <div className="flex flex-col gap-1 items-end">
          <div className="flex gap-1.5 items-center justify-end">
            {/* PAID rows get dedicated Accept + Decline buttons that hit
                /accept and /decline directly. Both are hidden the moment
                overrideStatus flips them off PAID. */}
            {isPaid && (
              <>
                <button
                  type="button"
                  className="btn-p btn-sm btn-success"
                  onClick={handleAccept}
                  disabled={disabled}
                >
                  {actionInFlight === 'accept' ? (<><span className="spin" /> …</>) : '✅ Accept'}
                </button>
                <button
                  type="button"
                  className="btn-del-solid btn-sm"
                  onClick={handleDecline}
                  disabled={disabled}
                >
                  {actionInFlight === 'decline' ? (<><span className="spin" /> …</>) : '✗ Decline'}
                </button>
                {order.pos_connected && (
                  <span className="text-[10px] uppercase tracking-wide border border-rim text-dim rounded-full px-2 py-0.5 leading-none">
                    POS Connected
                  </span>
                )}
              </>
            )}
            {!isPaid && next && (
              <button
                type="button"
                className="btn-g btn-sm"
                onClick={handleNextStatus}
                disabled={disabled}
              >
                {actionInFlight === 'next' ? (<><span className="spin" /> …</>) : next[1]}
              </button>
            )}
            <button
              type="button"
              className="btn-g btn-sm"
              onClick={() => onViewDetail?.(order.id)}
              disabled={disabled}
            >
              Detail
            </button>
          </div>
          {errorMsg && (
            <div className="text-xs text-red text-right max-w-[240px]">
              {errorMsg}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
