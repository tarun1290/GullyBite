'use client';

// Web-staff order list. Polls /api/staff/orders every 15s, plays a
// looping alarm while any PAID order is outstanding, and exposes the
// staff-allowed transitions:
//
//   PAID       → CONFIRMED        (Accept)         POST /restaurant/orders/:id/accept
//   PAID       → REJECTED…        (Decline)        POST /restaurant/orders/:id/decline
//   CONFIRMED  → PREPARING        (Start prep)     PATCH /staff/orders/:id/status
//   PREPARING  → PACKED           (Mark packed)    PATCH /staff/orders/:id/status
//
// Token expiry: any 401 from the polling loop or an action button
// clears 'staff_web_token' and silently bounces the user back to the
// login page (../).
//
// Audio: HTMLAudioElement, looped, served from /sounds/new_order.mp3.
// Chrome's autoplay policy requires a user-gesture before the first
// .play() — we rely on the sign-in tap for that gesture; if the audio
// still won't start (page reloaded into the orders view, no gesture
// yet), we bind a one-shot pointerdown listener that calls .load()
// from inside the gesture handler.

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getStaffOrders,
  staffAcceptOrder,
  staffDeclineOrder,
  staffUpdateOrderStatus,
  type StaffStatusKey,
} from '../../../../api/staff';
import { clearStaffToken, getStaffToken } from '../../../../lib/staffApiClient';
import type { StaffOrder } from '../../../../types';

interface PageProps {
  params: Promise<{ staffAccessToken: string }>;
}

const POLL_MS = 15_000;
const AUDIO_SRC = '/sounds/new_order.mp3';

function isUnauthorized(err: unknown): boolean {
  const e = err as { response?: { status?: number } };
  return e?.response?.status === 401;
}

function fmtTime(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function StaffOrdersPage({ params }: PageProps) {
  const { staffAccessToken } = use(params);
  const router = useRouter();

  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Module-style refs for the audio element + the set of PAID ids
  // we've already triggered a chime for. A ref instead of state so
  // updating it doesn't re-render and the alarm can be driven from
  // inside callbacks without stale closures.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seenPaidRef = useRef<Set<string>>(new Set());
  const unlockBoundRef = useRef<boolean>(false);

  const goLogin = useCallback(() => {
    clearStaffToken();
    router.replace(`/staff/${encodeURIComponent(staffAccessToken)}`);
  }, [router, staffAccessToken]);

  // No token → bounce to login. Done in an effect so we render nothing
  // before the redirect (vs a guard in the body that flashes an empty
  // shell).
  useEffect(() => {
    if (!getStaffToken()) {
      goLogin();
    }
  }, [goLogin]);

  // Lazy-init the audio element + bind the autoplay-unlock fallback.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!audioRef.current) {
      try {
        const a = new Audio(AUDIO_SRC);
        a.loop = true;
        a.preload = 'auto';
        audioRef.current = a;
      } catch {
        audioRef.current = null;
      }
    }
    if (unlockBoundRef.current) return;
    const unlock = () => {
      try { audioRef.current?.load(); } catch { /* ignore */ }
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    unlockBoundRef.current = true;
  }, []);

  const stopAlarm = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    try { a.pause(); a.currentTime = 0; } catch { /* ignore */ }
  }, []);

  const startAlarm = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!a.paused) return;
    try {
      a.currentTime = 0;
      void a.play().catch(() => { /* gesture not yet given — try next poll */ });
    } catch { /* ignore */ }
  }, []);

  // Diff incoming orders against our seen-PAID snapshot to decide
  // whether the alarm should be ringing.
  const reconcileAlarm = useCallback((next: StaffOrder[]) => {
    const currentPaid = new Set<string>();
    for (const o of next) {
      if (o && o.status === 'PAID') currentPaid.add(o.id);
    }
    let hasNew = false;
    for (const id of currentPaid) {
      if (!seenPaidRef.current.has(id)) { hasNew = true; break; }
    }
    if (currentPaid.size === 0) {
      stopAlarm();
    } else if (hasNew) {
      startAlarm();
    }
    seenPaidRef.current = currentPaid;
  }, [startAlarm, stopAlarm]);

  const fetchOrders = useCallback(async () => {
    try {
      const next = await getStaffOrders();
      setOrders(next);
      reconcileAlarm(next);
      setError(null);
    } catch (err: unknown) {
      if (isUnauthorized(err)) {
        goLogin();
        return;
      }
      const e = err as { userMessage?: string | null; message?: string };
      setError(e?.userMessage || e?.message || 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [goLogin, reconcileAlarm]);

  // Initial load + 15s polling.
  useEffect(() => {
    let active = true;
    void fetchOrders();
    const id = window.setInterval(() => { if (active) void fetchOrders(); }, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(id);
      stopAlarm();
    };
  }, [fetchOrders, stopAlarm]);

  const onAccept = async (orderId: string) => {
    if (actionPending) return;
    setActionPending(orderId);
    try {
      await staffAcceptOrder(orderId);
      await fetchOrders();
    } catch (err: unknown) {
      if (isUnauthorized(err)) { goLogin(); return; }
      const e = err as { userMessage?: string | null; message?: string };
      setError(e?.userMessage || e?.message || 'Accept failed');
    } finally {
      setActionPending(null);
    }
  };

  const onDecline = async (orderId: string) => {
    if (actionPending) return;
    const reason = window.prompt('Reason for declining?');
    if (!reason || !reason.trim()) return;
    setActionPending(orderId);
    try {
      await staffDeclineOrder(orderId, reason.trim());
      await fetchOrders();
    } catch (err: unknown) {
      if (isUnauthorized(err)) { goLogin(); return; }
      const e = err as { userMessage?: string | null; message?: string };
      setError(e?.userMessage || e?.message || 'Decline failed');
    } finally {
      setActionPending(null);
    }
  };

  const onAdvance = async (orderId: string, status: StaffStatusKey) => {
    if (actionPending) return;
    setActionPending(orderId);
    try {
      await staffUpdateOrderStatus(orderId, status);
      await fetchOrders();
    } catch (err: unknown) {
      if (isUnauthorized(err)) { goLogin(); return; }
      const e = err as { userMessage?: string | null; message?: string };
      setError(e?.userMessage || e?.message || 'Update failed');
    } finally {
      setActionPending(null);
    }
  };

  const onSignOut = () => {
    stopAlarm();
    goLogin();
  };

  return (
    <main style={{ flex: 1, padding: '1rem 1rem 2rem', maxWidth: 720, margin: '0 auto', width: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1rem',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Live Orders</h1>
        <button
          type="button"
          onClick={onSignOut}
          style={{
            padding: '.4rem .7rem',
            fontSize: '.78rem',
            background: 'transparent',
            border: '1px solid var(--rim,#1f2a3d)',
            color: 'var(--dim,#94a3b8)',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </header>

      {error && (
        <div
          style={{
            padding: '.5rem .7rem',
            marginBottom: '.8rem',
            background: 'rgba(220,38,38,0.12)',
            border: '1px solid rgba(220,38,38,0.4)',
            color: '#fca5a5',
            borderRadius: 8,
            fontSize: '.82rem',
          }}
        >
          {error}
        </div>
      )}

      {loading && orders.length === 0 ? (
        <p style={{ color: 'var(--dim,#94a3b8)', fontSize: '.9rem' }}>Loading orders…</p>
      ) : orders.length === 0 ? (
        <p style={{ color: 'var(--dim,#94a3b8)', fontSize: '.9rem' }}>No active orders right now.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
          {orders.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              busy={actionPending === o.id}
              onAccept={() => onAccept(o.id)}
              onDecline={() => onDecline(o.id)}
              onPreparing={() => onAdvance(o.id, 'preparing')}
              onPacked={() => onAdvance(o.id, 'packed')}
            />
          ))}
        </div>
      )}
    </main>
  );
}

interface OrderCardProps {
  order: StaffOrder;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onPreparing: () => void;
  onPacked: () => void;
}

function OrderCard({ order, busy, onAccept, onDecline, onPreparing, onPacked }: OrderCardProps) {
  const isPaid = order.status === 'PAID';
  const isConfirmed = order.status === 'CONFIRMED';
  const isPreparing = order.status === 'PREPARING';

  return (
    <div
      style={{
        background: isPaid ? 'rgba(220,38,38,0.08)' : 'var(--ink2,#0f1729)',
        border: `1px solid ${isPaid ? 'rgba(220,38,38,0.5)' : 'var(--rim,#1f2a3d)'}`,
        borderRadius: 10,
        padding: '.8rem',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '.5rem' }}>
        <div>
          <div style={{ fontSize: '.95rem', fontWeight: 600 }}>#{order.order_number}</div>
          <div style={{ fontSize: '.78rem', color: 'var(--dim,#94a3b8)' }}>
            {order.customer_name} · {order.customer_phone_masked}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '.9rem', fontWeight: 600 }}>₹{order.total_rs}</div>
          <div style={{ fontSize: '.7rem', color: 'var(--dim,#94a3b8)' }}>
            {fmtTime(order.created_at)} · {order.status}
          </div>
        </div>
      </div>

      {order.items.length > 0 && (
        <ul
          style={{
            margin: '.6rem 0 .3rem',
            padding: 0,
            listStyle: 'none',
            fontSize: '.82rem',
            color: 'var(--fg,#e6edf3)',
          }}
        >
          {order.items.map((it, i) => (
            <li key={`${order.id}-${i}`}>
              {it.quantity}× {it.name}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', marginTop: '.6rem' }}>
        {isPaid && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onAccept}
              style={btnStyle('var(--gb-green-600,#059669)', busy)}
            >
              {busy ? 'Working…' : 'Accept'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDecline}
              style={btnStyle('var(--gb-red-600,#dc2626)', busy)}
            >
              Decline
            </button>
          </>
        )}
        {isConfirmed && (
          <button
            type="button"
            disabled={busy}
            onClick={onPreparing}
            style={btnStyle('var(--gb-amber-600,#d97706)', busy)}
          >
            {busy ? 'Working…' : 'Start preparing'}
          </button>
        )}
        {isPreparing && (
          <button
            type="button"
            disabled={busy}
            onClick={onPacked}
            style={btnStyle('var(--gb-blue-600,#2563eb)', busy)}
          >
            {busy ? 'Working…' : 'Mark packed'}
          </button>
        )}
      </div>
    </div>
  );
}

function btnStyle(bg: string, busy: boolean): React.CSSProperties {
  return {
    padding: '.5rem .9rem',
    fontSize: '.85rem',
    background: busy ? 'var(--rim,#1f2a3d)' : bg,
    color: 'white',
    border: 'none',
    borderRadius: 6,
    cursor: busy ? 'default' : 'pointer',
    fontWeight: 600,
  };
}
