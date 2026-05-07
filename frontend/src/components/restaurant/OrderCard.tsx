'use client';

import { useState } from 'react';
import type { Order, OrderStatus } from '../../types';

// Status → [badge class, label]. Mirrors sbadge() in legacy orders.js:33-50.
const STATUS_BADGE: Record<string, [string, string]> = {
  PENDING_PAYMENT: ['ba', 'Pending Payment'],
  PAYMENT_FAILED:  ['br', 'Payment Failed'],
  EXPIRED:         ['bd', 'Expired'],
  PAID:            ['bb', 'Paid'],
  CONFIRMED:       ['bg', 'Confirmed'],
  PREPARING:       ['ba', 'Preparing'],
  PACKED:          ['bb', 'Packed'],
  DISPATCHED:      ['bv', 'Dispatched'],
  DELIVERED:       ['bg', 'Delivered'],
  CANCELLED:       ['br', 'Cancelled'],
  PAID_OUT:        ['bg', 'Paid Out'],
  PENDING:         ['ba', 'Pending'],
};

// PAID → CONFIRMED, then CONFIRMED auto-advances to PREPARING from
// the calling site (orders/page.tsx handleStatusChange + the new-order
// popup). PREPARING → PACKED stays as a manual click — the kitchen
// signals when packing is done. CONFIRMED is intentionally absent
// here so no "Prep" button appears on the owner dashboard; the staff
// app retains its own explicit prep control. Later statuses
// (PACKED → DISPATCHED, DELIVERED) flow through the dispatch path.
const NEXT_STATUS: Record<string, [string, string]> = {
  PAID:      ['CONFIRMED', '✅ Confirm'],
  PREPARING: ['PACKED',    '📦 Packed'],
};

const ACTIVE_ETA_STATUSES = new Set<string>(['PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED']);

// Row left-accent color by status, mirroring the badge color family. Lets the
// operator scan the orders table by color before reading the badge text.
const STATUS_ROW_COLOR: Record<string, string> = {
  PENDING_PAYMENT: 'var(--gold)',
  PREPARING:       'var(--gold)',
  PAYMENT_FAILED:  'var(--red)',
  CANCELLED:       'var(--red)',
  EXPIRED:         'var(--mute)',
  PAID:            'var(--blue)',
  PACKED:          'var(--blue)',
  CONFIRMED:       'var(--wa)',
  DELIVERED:       'var(--wa)',
  PAID_OUT:        'var(--wa)',
  DISPATCHED:      'var(--gb-teal-700)',
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

interface OrderCardProps {
  order: Order;
  onStatusChange?: (id: string, nextStatus: string) => void | Promise<void>;
  onDispatch?: (id: string) => void | Promise<void>;
  onViewDetail?: (id: string) => void;
  // Decline triggers the dedicated /decline route on the backend
  // (refund + REJECTED_BY_RESTAURANT transition). Passed in by the
  // parent so the page-level toast/refetch flow stays consistent.
  // Only PAID rows render the Decline button regardless.
  onDecline?: (id: string) => void | Promise<void>;
  busy?: boolean;
}

export default function OrderCard({ order, onStatusChange, onViewDetail, onDecline, busy = false }: OrderCardProps) {
  const [localBusy, setLocalBusy] = useState<boolean>(false);
  const [decliningLocal, setDecliningLocal] = useState<boolean>(false);
  const next = NEXT_STATUS[order.status];
  const disabled = busy || localBusy || decliningLocal;

  const handleNextStatus = async () => {
    if (disabled || !next) return;
    setLocalBusy(true);
    try {
      await onStatusChange?.(order.id, next[0]);
    } finally {
      setLocalBusy(false);
    }
  };

  const handleDecline = async () => {
    if (disabled || !onDecline) return;
    setDecliningLocal(true);
    try {
      await onDecline(order.id);
    } finally {
      setDecliningLocal(false);
    }
  };

  const statusColor = STATUS_ROW_COLOR[order.status] || 'transparent';

  return (
    <tr
      // borderLeft colour comes from STATUS_ROW_COLOR by order.status at
      // runtime (gold/red/mute/blue/wa/teal — 7 distinct CSS vars).
      style={{ borderLeft: `3px solid ${statusColor}` }}
    >
      <td><span className="mono">{order.display_order_id || `#${(order.id || '').slice(-6) || '????'}`}</span></td>
      <td>
        <div>{order.customer_name || '—'}</div>
        <div className="text-[0.72rem] text-dim">
          {customerSecondary(order)}
        </div>
      </td>
      <td>{order.branch_name || ''}</td>
      <td>₹{order.total_rs}</td>
      <td><StatusBadge status={order.status} /></td>
      <td className="text-[0.73rem]"><EtaCell order={order} /></td>
      <td className="text-[0.73rem] text-dim">{timeAgo(order.created_at)}</td>
      <td>
        <div className="flex gap-[0.35rem] items-center justify-end">
          {next && (
            <button
              type="button"
              className="btn-g btn-sm"
              onClick={handleNextStatus}
              disabled={disabled}
            >
              {localBusy ? (<><span className="spin" /> …</>) : next[1]}
            </button>
          )}
          {/* Decline button — PAID rows only. Hits /decline (refund +
              REJECTED_BY_RESTAURANT) via the parent-supplied onDecline.
              Outlined red so it doesn't compete visually with the
              filled green Confirm button. */}
          {order.status === 'PAID' && onDecline && (
            <button
              type="button"
              className="btn-sm bg-transparent text-red-600 border-[1.5px] border-red-600 font-semibold"
              onClick={handleDecline}
              disabled={disabled}
            >
              {decliningLocal ? (<><span className="spin" /> …</>) : '✗ Decline'}
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
      </td>
    </tr>
  );
}
