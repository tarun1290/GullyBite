'use client';

// Amber pill that surfaces "this order has a Prorouting dispute" on
// both the restaurant and admin order detail surfaces. Intentionally
// minimal — the badge itself is a status indicator; resolution + close
// flows live on the existing admin /orders/:id/issue/close route and
// aren't replicated here.

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
      className="mt-2.5 py-2 px-3 bg-amber-100 border border-amber-200 rounded-lg flex items-center gap-2.5 flex-wrap text-sm text-amber-800"
    >
      <span className="font-bold">⚠ Dispute Raised</span>
      <span
        className="mono text-xs text-amber-800 opacity-[0.85]"
        title="Prorouting issue id"
      >
        {issueId}
      </span>
      {raisedAt && (
        <span className="ml-auto text-xs text-dim">
          {fmt(raisedAt)}
        </span>
      )}
    </div>
  );
}
