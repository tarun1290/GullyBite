'use client';

// Mirrors the left-pane issue list. Adapted from legacy loadIssueList()
// (messages.js:280-319) — presented as a list (not table) so it fits the
// two-pane MessagesTab layout the spec prescribes. Row cells keep the same
// priority/status palettes as legacy (messages.js:247-249).

const PRI_CLR: Record<string, string> = { critical: '#dc2626', high: '#f59e0b', medium: '#3b82f6', low: '#94a3b8' };
const ST_CLR:  Record<string, string> = { open: '#3b82f6', assigned: '#8b5cf6', in_progress: '#f59e0b', waiting_customer: '#6366f1', escalated_to_admin: '#dc2626', resolved: '#16a34a', closed: '#64748b', reopened: '#ef4444' };

const CAT_LABEL: Record<string, string> = {
  food_quality: '🍕 Food Quality', missing_item: '📦 Missing Item', wrong_order: '❌ Wrong Order',
  portion_size: '📏 Portion', packaging: '📦 Packaging', hygiene: '🧹 Hygiene',
  delivery_late: '🕐 Late', delivery_not_received: '🚫 Not Received', delivery_damaged: '💥 Damaged',
  rider_behavior: '🛵 Rider', wrong_address: '📍 Wrong Addr', wrong_charge: '💸 Wrong Charge',
  refund_request: '💰 Refund', payment_failed: '⚠️ Payment', coupon_issue: '🏷️ Coupon',
  general: '💬 General', app_issue: '📱 App',
};

export interface IssueListItem {
  _id?: string;
  id?: string;
  issue_number?: string;
  category?: string;
  priority?: string;
  status?: string;
  customer_name?: string;
  order_number?: string;
  display_order_id?: string;
  created_at?: string;
}

function timeAgo(ts?: string): string {
  if (!ts) return '';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.max(0, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface IssueRowProps {
  issue: IssueListItem;
  active: boolean;
  onSelect?: ((id: string) => void) | undefined;
}

function IssueRow({ issue, active, onSelect }: IssueRowProps) {
  const priClr = PRI_CLR[issue.priority || ''] || '#94a3b8';
  const stClr  = ST_CLR[issue.status || ''] || '#64748b';
  const id = issue._id || issue.id || '';
  return (
    <div
      onClick={() => onSelect?.(id)}
      className={`py-[0.6rem] px-[0.7rem] rounded-lg cursor-pointer border transition-all duration-150 ${
        active ? 'border-wa bg-[rgba(37,211,102,0.08)]' : 'border-transparent bg-transparent'
      }`}
    >
      <div className="flex justify-between items-center gap-[0.4rem]">
        <span className="font-semibold text-[0.8rem] whitespace-nowrap">{issue.issue_number}</span>
        <span className="text-[0.68rem] text-dim">{timeAgo(issue.created_at)}</span>
      </div>
      <div className="text-[0.76rem] text-dim mt-[0.15rem]">
        {CAT_LABEL[issue.category || ''] || issue.category} · {issue.customer_name || '—'}
      </div>
      <div className="flex gap-[0.3rem] mt-[0.3rem] items-center flex-wrap">
        <span
          className="font-semibold text-[0.62rem] uppercase"
          // priority colour comes from PRI_CLR by issue.priority at
          // runtime (critical/high/medium/low — 4 distinct hex).
          style={{ color: priClr }}
        >
          {issue.priority}
        </span>
        <span
          className="text-white text-[0.6rem] py-[0.1rem] px-[0.4rem] rounded-[4px] font-semibold"
          // status colour comes from ST_CLR by issue.status at runtime
          // (open/assigned/in_progress/.../closed — 8 distinct hex).
          style={{ background: stClr }}
        >
          {(issue.status || '').replace(/_/g, ' ')}
        </span>
        {/* Per the order-id-display policy, restaurant-facing UI never
            shows the legacy ZM-YYYYMMDD-NNNN. Issue rows don't carry
            the order's UUID, so when display_order_id isn't populated
            (legacy orders) we render '—' rather than leak order_number.
            Backend follow-up: join issues to orders.display_order_id in
            the issue serializer so the fallback rarely fires. */}
        {issue.display_order_id ? (
          <span className="text-[0.62rem] text-dim">{issue.display_order_id}</span>
        ) : null}
      </div>
    </div>
  );
}

interface IssueListProps {
  issues: IssueListItem[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  loading?: boolean;
}

export default function IssueList({ issues, selectedId, onSelect, loading }: IssueListProps) {
  if (loading) {
    return (
      <div className="text-center py-8 px-2">
        <div className="spin mx-auto" />
      </div>
    );
  }
  if (!issues || issues.length === 0) {
    return (
      <div className="text-center text-dim py-8 px-2 text-[0.82rem]">
        No issues found
      </div>
    );
  }
  return (
    <>
      {issues.map((i) => {
        const id = i._id || i.id || '';
        return <IssueRow key={id} issue={i} active={selectedId === id} onSelect={onSelect} />;
      })}
    </>
  );
}

export { CAT_LABEL, PRI_CLR, ST_CLR };
