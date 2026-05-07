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
    <main className="flex-1 pt-4 px-4 pb-8 max-w-[720px] mx-auto w-full">
      <header className="flex items-center justify-between mb-4">
        <h1 className="m-0 text-[1.1rem] font-semibold">Live Orders</h1>
        <button
          type="button"
          onClick={onSignOut}
          className="py-[0.4rem] px-[0.7rem] text-[0.78rem] bg-transparent border border-rim text-dim rounded-md cursor-pointer"
        >
          Sign out
        </button>
      </header>

      {error && (
        <div className="py-2 px-[0.7rem] mb-[0.8rem] bg-[rgba(220,38,38,0.12)] border border-[rgba(220,38,38,0.4)] text-[#fca5a5] rounded-lg text-[0.82rem]">
          {error}
        </div>
      )}

      {loading && orders.length === 0 ? (
        <p className="text-dim text-[0.9rem]">Loading orders…</p>
      ) : orders.length === 0 ? (
        <p className="text-dim text-[0.9rem]">No active orders right now.</p>
      ) : (
        <div className="flex flex-col gap-[0.8rem]">
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
    <div className={`rounded-[10px] p-[0.8rem] border ${isPaid ? 'bg-[rgba(220,38,38,0.08)] border-[rgba(220,38,38,0.5)]' : 'bg-ink2 border-rim'}`}>
      <div className="flex justify-between items-baseline gap-2">
        <div>
          <div className="text-[0.95rem] font-semibold">#{order.order_number}</div>
          <div className="text-[0.78rem] text-dim">
            {order.customer_name} · {order.customer_phone_masked}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[0.9rem] font-semibold">₹{order.total_rs}</div>
          <div className="text-[0.7rem] text-dim">
            {fmtTime(order.created_at)} · {order.status}
          </div>
        </div>
      </div>

      {order.items.length > 0 && (
        <ul className="mt-[0.6rem] mb-[0.3rem] p-0 list-none text-[0.82rem] text-fg">
          {order.items.map((it, i) => (
            <li key={`${order.id}-${i}`}>
              {it.quantity}× {it.name}
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-[0.4rem] flex-wrap mt-[0.6rem]">
        {isPaid && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onAccept}
              className={`${BTN_BASE_CLS} ${busy ? BTN_BUSY_CLS : 'bg-green-600 cursor-pointer'}`}
            >
              {busy ? 'Working…' : 'Accept'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDecline}
              className={`${BTN_BASE_CLS} ${busy ? BTN_BUSY_CLS : 'bg-red-600 cursor-pointer'}`}
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
            className={`${BTN_BASE_CLS} ${busy ? BTN_BUSY_CLS : 'bg-amber-600 cursor-pointer'}`}
          >
            {busy ? 'Working…' : 'Start preparing'}
          </button>
        )}
        {isPreparing && (
          <button
            type="button"
            disabled={busy}
            onClick={onPacked}
            className={`${BTN_BASE_CLS} ${busy ? BTN_BUSY_CLS : 'bg-blue-600 cursor-pointer'}`}
          >
            {busy ? 'Working…' : 'Mark packed'}
          </button>
        )}
      </div>
    </div>
  );
}

const BTN_BASE_CLS = 'py-2 px-[0.9rem] text-[0.85rem] text-white border-0 rounded-md font-semibold';
const BTN_BUSY_CLS = 'bg-rim cursor-default';
