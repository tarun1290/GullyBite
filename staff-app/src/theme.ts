// Shared colours / spacing. Keep in sync with the dashboard's CSS custom
// properties so the two apps feel like one brand.

export const colors = {
  acc: '#4338ca',
  acc2: '#3730a3',
  accGlow: 'rgba(67, 56, 202, 0.12)',
  ink: '#f8f9fb',
  ink2: '#ffffff',
  rim: '#e5e7eb',
  rim2: '#d1d5db',
  tx: '#111827',
  dim: '#6b7280',
  mute: '#9ca3af',
  wa: '#16a34a',
  gold: '#d97706',
  red: '#dc2626',
  blue: '#2563eb',
  purple: '#7c3aed',
};

export const statusBadge = {
  PENDING_PAYMENT: { bg: '#fff7ed', fg: '#c2410c', label: 'Pending Payment' },
  pending: { bg: '#fff7ed', fg: '#c2410c', label: 'New' },
  CONFIRMED: { bg: '#dbeafe', fg: '#1d4ed8', label: 'Confirmed' },
  confirmed: { bg: '#dbeafe', fg: '#1d4ed8', label: 'Confirmed' },
  PREPARING: { bg: '#fef3c7', fg: '#b45309', label: 'Preparing' },
  preparing: { bg: '#fef3c7', fg: '#b45309', label: 'Preparing' },
  PACKED: { bg: '#d1fae5', fg: '#15803d', label: 'Ready' },
  ready: { bg: '#d1fae5', fg: '#15803d', label: 'Ready' },
  DISPATCHED: { bg: '#ede9fe', fg: '#6d28d9', label: 'Out for Delivery' },
  out_for_delivery: { bg: '#ede9fe', fg: '#6d28d9', label: 'Out for Delivery' },
  DELIVERED: { bg: '#f3f4f6', fg: '#4b5563', label: 'Delivered' },
  delivered: { bg: '#f3f4f6', fg: '#4b5563', label: 'Delivered' },
  CANCELLED: { bg: '#fee2e2', fg: '#b91c1c', label: 'Cancelled' },
  cancelled: { bg: '#fee2e2', fg: '#b91c1c', label: 'Cancelled' },
} as const;

export function badgeFor(status: string | undefined | null) {
  if (!status) return { bg: '#f3f4f6', fg: '#4b5563', label: 'Unknown' };
  return (
    (statusBadge as Record<string, { bg: string; fg: string; label: string }>)[status] || {
      bg: '#f3f4f6',
      fg: '#4b5563',
      label: status,
    }
  );
}
