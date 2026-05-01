'use client';

// Live rider-location card. Reads lastRiderLocation off SocketProvider
// context (events fan in from /webhook/prorouting/track on the backend
// via emitToRestaurant) and renders a pulsing-dot card when the latest
// payload's order_id matches this card's orderId prop.
//
// Returns null when no matching event has arrived — drop-in safe for
// any order detail surface; only renders when there's actually a live
// rider feed for THIS order.
//
// Codebase doesn't use Tailwind utility classes — inline `style={{...}}`
// matches the existing convention (see LiveIndicator.tsx, OrderDetailModal.tsx).
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
  // keeps each card showing only its own rider.
  if (!lastRiderLocation || lastRiderLocation.order_id !== orderId) {
    return null;
  }

  const trackingUrl = lastRiderLocation.tracking_url;

  return (
    <>
      <style>{`@keyframes gb-rider-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50%      { opacity: 0.45; transform: scale(0.85); }
      }`}</style>
      <div
        style={{
          marginTop: '.6rem',
          padding: '.6rem .8rem',
          background: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          gap: '.7rem',
          flexWrap: 'wrap',
          fontSize: '.82rem',
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: '#16a34a',
            animation: 'gb-rider-pulse 1.5s ease-in-out infinite',
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600, color: '#15803d' }}>Rider is live</span>
        <span style={{ color: 'var(--dim)', fontSize: '.76rem' }}>
          updated {relativeTime(lastRiderLocation.updated_at)}
        </span>
        {trackingUrl && (
          <a
            href={trackingUrl}
            target="_blank"
            rel="noreferrer"
            className="btn-p btn-sm"
            style={{
              marginLeft: 'auto',
              textDecoration: 'none',
              fontSize: '.75rem',
            }}
          >
            📍 Track Rider
          </a>
        )}
      </div>
    </>
  );
}
