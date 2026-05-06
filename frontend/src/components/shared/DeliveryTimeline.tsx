'use client';

// Vertical milestone timeline of Prorouting (3PL) state transitions.
// Reads per-state timestamps stamped on the order by the status-callback
// handler at backend/src/routes/webhookProrouting.js. Renders nothing if
// prorouting_state is unset (pre-dispatch / non-3PL orders).
//
// Forward path: SEARCHING_AGENT → ASSIGNED → AT_PICKUP → PICKED_UP →
// AT_DELIVERY → DELIVERED.
// RTO branch (post-pickup customer issues): RTO_INITIATED → RTO_DELIVERED
// (returned to merchant) or RTO_DISPOSED (lost/damaged in transit).
// CANCELLED applies only pre-pickup (cancelled_at).
//
// The pulse keyframe is a uniquely-named one-off (gb-timeline-pulse) to
// avoid global collisions. Per-step palette colours come from
// paletteFor() at runtime (hex strings driven by status × tone) so the
// dot/ring/label colours stay inline; static layout uses Tailwind.

// Structural prop type — both `Order` (from types/index.ts) and
// `AdminOrderRow` (from app/admin/orders/page.tsx) satisfy this since
// both carry the same prorouting_* fields. Avoids a hard import-cycle on
// the full Order shape and lets the admin row pass through directly.
export interface DeliveryTimelineFields {
  prorouting_state?: string;
  prorouting_assigned_at?: string;
  prorouting_pickedup_at?: string;
  prorouting_delivered_at?: string;
  prorouting_at_pickup_at?: string;
  prorouting_at_delivery_at?: string;
  prorouting_rto_initiated_at?: string;
  prorouting_rto_delivered_at?: string;
  prorouting_cancelled_at?: string;
}

interface DeliveryTimelineProps {
  order: DeliveryTimelineFields;
}

// State-name → terminal-or-not. Used to gate the "current step" pulse
// (only show the pulse on the active step that has no timestamp yet).
const TERMINAL_STATES = new Set([
  'DELIVERED',
  'RTO_DELIVERED',
  'RTO_DISPOSED',
  'CANCELLED',
]);

// Format ISO → "5 May, 14:32". Falls back to raw on parse failure.
function fmtTime(iso?: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

type StepStatus = 'completed' | 'active' | 'future';
type StepTone = 'normal' | 'rto' | 'disposed';

interface TimelineStep {
  key: string;
  label: string;
  subtitle?: string;
  timestamp?: string;
  status: StepStatus;
  tone: StepTone;
}

// Palette per (status × tone). Solid green for completed normal-path,
// amber for RTO milestones, red for the RTO_DISPOSED terminal. Future
// steps are uniformly grey regardless of tone.
function paletteFor(status: StepStatus, tone: StepTone): {
  circle: string;
  ring: string;
  label: string;
} {
  if (status === 'future') {
    return { circle: '#e5e7eb', ring: '#e5e7eb', label: '#9ca3af' };
  }
  if (tone === 'disposed') {
    return { circle: '#dc2626', ring: '#fecaca', label: '#991b1b' };
  }
  if (tone === 'rto') {
    return { circle: '#d97706', ring: '#fed7aa', label: '#92400e' };
  }
  return { circle: '#16a34a', ring: '#bbf7d0', label: '#15803d' };
}

function buildSteps(order: DeliveryTimelineFields): TimelineStep[] {
  const state = order.prorouting_state || '';
  const isRtoPath = !!order.prorouting_rto_initiated_at
    || state === 'RTO_INITIATED'
    || state === 'RTO_DELIVERED'
    || state === 'RTO_DISPOSED';

  const steps: TimelineStep[] = [];

  // Step 1: Searching for Rider. No timestamp; this milestone exists
  // only as a transient "we're looking" indicator. Show as completed if
  // a later milestone exists (assigned_at), as active if state is
  // currently SEARCHING_AGENT, otherwise it's the implicit pre-state and
  // we still surface it for context.
  const assigned = order.prorouting_assigned_at;
  const searchingStatus: StepStatus = assigned
    ? 'completed'
    : state === 'SEARCHING_AGENT'
      ? 'active'
      : 'future';
  steps.push({
    key: 'searching',
    label: 'Searching for Rider',
    status: searchingStatus,
    tone: 'normal',
  });

  // Step 2: Rider Assigned.
  steps.push({
    key: 'assigned',
    label: 'Rider Assigned',
    timestamp: assigned,
    status: assigned
      ? 'completed'
      : state === 'ASSIGNED' ? 'active' : 'future',
    tone: 'normal',
  });

  // Step 3: Reached Pickup. Optional milestone — many runs skip straight
  // from ASSIGNED to PICKED_UP. Include only if we have a stamp OR the
  // state is currently AT_PICKUP.
  if (order.prorouting_at_pickup_at || state === 'AT_PICKUP') {
    steps.push({
      key: 'at_pickup',
      label: 'Reached Pickup',
      timestamp: order.prorouting_at_pickup_at,
      status: order.prorouting_at_pickup_at
        ? 'completed'
        : state === 'AT_PICKUP' ? 'active' : 'future',
      tone: 'normal',
    });
  }

  // Step 4: Picked Up.
  const pickedUp = order.prorouting_pickedup_at;
  steps.push({
    key: 'pickedup',
    label: 'Order Picked Up',
    timestamp: pickedUp,
    status: pickedUp
      ? 'completed'
      : state === 'PICKED_UP' ? 'active' : 'future',
    tone: 'normal',
  });

  // Step 5: Reached Customer. Optional, same shape as Reached Pickup.
  if (order.prorouting_at_delivery_at || state === 'AT_DELIVERY') {
    steps.push({
      key: 'at_delivery',
      label: 'Reached Customer',
      timestamp: order.prorouting_at_delivery_at,
      status: order.prorouting_at_delivery_at
        ? 'completed'
        : state === 'AT_DELIVERY' ? 'active' : 'future',
      tone: 'normal',
    });
  }

  // Step 6: Delivered. Skip on the RTO path — the order never reaches
  // the customer in that branch, and showing a future "Delivered" step
  // alongside the RTO milestones is misleading.
  if (!isRtoPath) {
    const delivered = order.prorouting_delivered_at;
    steps.push({
      key: 'delivered',
      label: 'Delivered',
      timestamp: delivered,
      status: delivered
        ? 'completed'
        : state === 'DELIVERED' ? 'active' : 'future',
      tone: 'normal',
    });
  }

  // ── RTO branch ────────────────────────────────────────────────────
  if (isRtoPath) {
    const rtoInit = order.prorouting_rto_initiated_at;
    steps.push({
      key: 'rto_initiated',
      label: 'RTO Initiated',
      subtitle: 'Customer unreachable or refused delivery',
      timestamp: rtoInit,
      status: rtoInit
        ? 'completed'
        : state === 'RTO_INITIATED' ? 'active' : 'future',
      tone: 'rto',
    });

    if (state === 'RTO_DISPOSED') {
      steps.push({
        key: 'rto_disposed',
        label: 'RTO Disposed',
        subtitle: 'Item lost or damaged in transit',
        status: 'completed',
        tone: 'disposed',
      });
    } else {
      const rtoDel = order.prorouting_rto_delivered_at;
      steps.push({
        key: 'rto_delivered',
        label: 'RTO Delivered',
        timestamp: rtoDel,
        status: rtoDel
          ? 'completed'
          : state === 'RTO_DELIVERED' ? 'active' : 'future',
        tone: 'rto',
      });
    }
  }

  return steps;
}

export default function DeliveryTimeline({ order }: DeliveryTimelineProps) {
  if (!order.prorouting_state) return null;

  const steps = buildSteps(order);
  const state = order.prorouting_state;
  const isTerminal = TERMINAL_STATES.has(state);

  return (
    <>
      <style>{`@keyframes gb-timeline-pulse {
        0%, 100% { transform: scale(1);   opacity: 1; }
        50%      { transform: scale(0.7); opacity: 0.5; }
      }`}</style>
      <ol className="list-none m-0 pt-[0.4rem] pb-[0.2rem] flex flex-col">
        {steps.map((s, idx) => {
          const palette = paletteFor(s.status, s.tone);
          const isLast = idx === steps.length - 1;
          // Pulse only on the truly active step (state matches, no
          // timestamp yet, and the run hasn't reached a terminal state).
          const showPulse = s.status === 'active' && !isTerminal;
          return (
            <li
              key={s.key}
              className={`flex gap-[0.7rem] relative ${isLast ? 'pb-0' : 'pb-[0.65rem]'}`}
            >
              {/* Connector line — drawn from circle bottom down to next
                  row's circle top. Coloured per the FROM step's status
                  so completed→completed shows the chain in palette. */}
              {!isLast && (
                <span
                  aria-hidden
                  className="absolute left-[5px] top-3 bottom-0 w-[2px]"
                  style={{
                    background: s.status === 'completed' ? palette.circle : '#e5e7eb',
                  }}
                />
              )}
              <span
                aria-hidden
                className="w-3 h-3 rounded-full shrink-0 mt-[2px]"
                style={{
                  background: palette.circle,
                  boxShadow: showPulse ? `0 0 0 4px ${palette.ring}` : 'none',
                  animation: showPulse ? 'gb-timeline-pulse 1.4s ease-in-out infinite' : 'none',
                }}
              />
              <div className="flex-1 min-w-0">
                <div
                  className={`text-[0.82rem] leading-[1.3] ${
                    s.status === 'completed' || s.status === 'active'
                      ? 'font-semibold'
                      : 'font-medium'
                  }`}
                  style={{ color: palette.label }}
                >
                  {s.label}
                </div>
                {s.timestamp && (
                  <div className="text-[0.72rem] text-dim mt-px">
                    {fmtTime(s.timestamp)}
                  </div>
                )}
                {s.subtitle && (
                  <div
                    className="text-[0.72rem] mt-px italic"
                    style={{ color: s.tone === 'disposed' ? '#991b1b' : '#92400e' }}
                  >
                    {s.subtitle}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {order.prorouting_cancelled_at && (
        <div className="mt-[0.4rem] py-[0.45rem] px-[0.65rem] bg-red-50 border border-red-200 rounded-md text-[0.74rem] text-red-800">
          Cancelled at {fmtTime(order.prorouting_cancelled_at)}
        </div>
      )}
    </>
  );
}
