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

// PAID→CONFIRMED, CONFIRMED→PREPARING, PREPARING→PACKED.
// From legacy orders.js:67. Later statuses have no status-button (handled via dispatch flow).
const NEXT_STATUS: Record<string, [string, string]> = {
  PAID:      ['CONFIRMED', '✅ Confirm'],
  CONFIRMED: ['PREPARING', '👨‍🍳 Prep'],
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
  DISPATCHED:      'var(--gb-violet-600)',
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
      return <span style={{ color: 'var(--wa)' }}>Delivered in {mins} min</span>;
    }
    return <span style={{ color: 'var(--wa)' }}>Delivered</span>;
  }
  if (ACTIVE_ETA_STATUSES.has(order.status) && order.eta_text) {
    return <span style={{ color: 'var(--gold)', fontWeight: 600 }}>⏱ {order.eta_text}</span>;
  }
  return <span style={{ color: 'var(--mute)' }}>—</span>;
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
  busy?: boolean;
}

export default function OrderCard({ order, onStatusChange, onViewDetail, busy = false }: OrderCardProps) {
  const [localBusy, setLocalBusy] = useState<boolean>(false);
  const next = NEXT_STATUS[order.status];
  const disabled = busy || localBusy;

  const handleNextStatus = async () => {
    if (disabled || !next) return;
    setLocalBusy(true);
    try {
      await onStatusChange?.(order.id, next[0]);
    } finally {
      setLocalBusy(false);
    }
  };

  const statusColor = STATUS_ROW_COLOR[order.status] || 'transparent';

  return (
    <tr style={{ borderLeft: `3px solid ${statusColor}` }}>
      <td><span className="mono">{order.order_number}</span></td>
      <td>
        <div>{order.customer_name || '—'}</div>
        <div style={{ fontSize: '.72rem', color: 'var(--dim)' }}>
          {customerSecondary(order)}
        </div>
      </td>
      <td>{order.branch_name || ''}</td>
      <td>₹{order.total_rs}</td>
      <td><StatusBadge status={order.status} /></td>
      <td style={{ fontSize: '.73rem' }}><EtaCell order={order} /></td>
      <td style={{ fontSize: '.73rem', color: 'var(--dim)' }}>{timeAgo(order.created_at)}</td>
      <td>
        <div style={{ display: 'flex', gap: '.35rem', alignItems: 'center', justifyContent: 'flex-end' }}>
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
