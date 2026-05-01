'use client';

// Amber pill that surfaces "this order has a Prorouting dispute" on
// both the restaurant and admin order detail surfaces. Intentionally
// minimal — the badge itself is a status indicator; resolution + close
// flows live on the existing admin /orders/:id/issue/close route and
// aren't replicated here.
//
// Codebase doesn't use Tailwind — inline `style={{...}}` matches the
// convention used by RiderLocationCard, DeliveryTimeline, etc.

interface IssueStatusBadgeProps {
  issueId?: string;
  raisedAt?: string;
}

function fmt(raisedAt?: string): string {
  if (!raisedAt) return '';
  const ts = Date.parse(raisedAt);
  if (Number.isNaN(ts)) return raisedAt;
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return raisedAt;
  }
}

export default function IssueStatusBadge({ issueId, raisedAt }: IssueStatusBadgeProps) {
  if (!issueId) return null;

  return (
    <div
      role="status"
      aria-label="Delivery dispute raised"
      style={{
        marginTop: '.6rem',
        padding: '.55rem .75rem',
        background: '#fef3c7',
        border: '1px solid #fde68a',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: '.6rem',
        flexWrap: 'wrap',
        fontSize: '.8rem',
        color: '#92400e',
      }}
    >
      <span style={{ fontWeight: 700 }}>⚠ Dispute Raised</span>
      <span
        className="mono"
        style={{ fontSize: '.72rem', color: '#92400e', opacity: 0.85 }}
        title="Prorouting issue id"
      >
        {issueId}
      </span>
      {raisedAt && (
        <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: 'var(--dim)' }}>
          {fmt(raisedAt)}
        </span>
      )}
    </div>
  );
}
