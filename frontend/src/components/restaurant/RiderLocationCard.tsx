'use client';

// Live rider-location card. Reads lastRiderLocation off SocketProvider
// context (events fan in from /webhook/prorouting/track on the backend
// via emitToRestaurant) and renders a pulsing-dot card when the latest
// payload's order_uuid matches this card's orderId prop. The prop is
// the orders._id UUID (passed in from OrderDetailModal); order_id on
// the payload is the human-readable order_number which is what the
// staff-app SSE consumer keys on instead.
//
// Returns null when no matching event has arrived — drop-in safe for
// any order detail surface; only renders when there's actually a live
// rider feed for THIS order.
//
// The pulsing dot animation is a one-off `<style>` block with a uniquely-named
// keyframes (gb-rider-pulse) to avoid global collisions.

import { useSocketContext } from '../shared/SocketProvider';

interface RiderLocationCardProps {
  orderId: string;
}

// Inline relative-time helper. date-fns isn't in the project deps, and
// pulling it in just for "X mins ago" isn't worth the bundle cost. Falls
// back to the raw ISO when parsing fails.
function relativeTime(updatedAt: string): string {
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return updatedAt;
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return updatedAt;
}

export default function RiderLocationCard({ orderId }: RiderLocationCardProps) {
  const { lastRiderLocation } = useSocketContext();

  // Filter: only render if the latest rider event is for THIS order.
  // Other in-flight orders at the same restaurant will land in
  // lastRiderLocation too (per-restaurant room scope) — this gate
  // keeps each card showing only its own rider. Compare on order_uuid
  // (orders._id) because that's what OrderDetailModal passes as the
  // orderId prop; the payload's order_id field is the order_number
  // string which would never match a UUID prop.
  if (!lastRiderLocation || lastRiderLocation.order_uuid !== orderId) {
    return null;
  }

  const trackingUrl = lastRiderLocation.tracking_url;

  return (
    <>
      <style>{`@keyframes gb-rider-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50%      { opacity: 0.45; transform: scale(0.85); }
      }`}</style>
      <div className="mt-2.5 py-2.5 px-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-3 flex-wrap text-sm">
        <span
          aria-hidden
          className="inline-block w-[9px] h-[9px] rounded-full bg-green-600 shrink-0"
          // animation references the gb-rider-pulse keyframes injected
          // above — Tailwind's animate-* utilities can't bind to it.
          style={{ animation: 'gb-rider-pulse 1.5s ease-in-out infinite' }}
        />
        <span className="font-semibold text-green-700">Rider is live</span>
        <span className="text-dim text-xs">
          updated {relativeTime(lastRiderLocation.updated_at)}
        </span>
        {trackingUrl && (
          <a
            href={trackingUrl}
            target="_blank"
            rel="noreferrer"
            className="btn-p btn-xs ml-auto no-underline"
          >
            📍 Track Rider
          </a>
        )}
      </div>
    </>
  );
}
