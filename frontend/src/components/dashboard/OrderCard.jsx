import { useState } from 'react';

// Status → [badge class, label]. Mirrors sbadge() in legacy orders.js:33-50.
const STATUS_BADGE = {
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
const NEXT_STATUS = {
  PAID:      ['CONFIRMED', '✅ Confirm'],
  CONFIRMED: ['PREPARING', '👨‍🍳 Prep'],
  PREPARING: ['PACKED',    '📦 Packed'],
};

const ACTIVE_ETA_STATUSES = new Set(['PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED']);

// Row left-accent color by status, mirroring the badge color family. Lets the
// operator scan the orders table by color before reading the badge text.
const STATUS_ROW_COLOR = {
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

export function StatusBadge({ status }) {
  const [cls, label] = STATUS_BADGE[status] || ['bd', (status || '').replace(/_/g, ' ')];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function EtaCell({ order }) {
  if (order.status === 'DELIVERED') {
    if (order.created_at && order.delivered_at) {
      const mins = Math.round((new Date(order.delivered_at) - new Date(order.created_at)) / 60000);
      return <span style={{ color: 'var(--wa)' }}>Delivered in {mins} min</span>;
    }
    return <span style={{ color: 'var(--wa)' }}>Delivered</span>;
  }
  if (ACTIVE_ETA_STATUSES.has(order.status) && order.eta_text) {
    return <span style={{ color: 'var(--gold)', fontWeight: 600 }}>⏱ {order.eta_text}</span>;
  }
  return <span style={{ color: 'var(--mute)' }}>—</span>;
}

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.max(0, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function customerSecondary(order) {
  if (order.wa_phone) return order.wa_phone;
  if (order.bsuid) return `${String(order.bsuid).slice(0, 12)}…`;
  return '';
}

export default function OrderCard({ order, onStatusChange, onDispatch, onViewDetail, busy = false }) {
  const [localBusy, setLocalBusy] = useState(false);
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
