'use client';

// Web-staff order list (patched: no URL token).
//
// Identity is read from /api/staff/auth/me on mount. A 401 from /me or
// any subsequent action redirects to /staff/login. Permission gating
// hides action buttons the staff member is not allowed to use:
//   accept_orders → "Accept" button
//   reject_orders → "Decline" button
//   mark_ready    → "Start preparing" / "Mark packed" buttons
//   view_orders   → if false, render an inline access-denied card
//                   instead of the order list.
//
// Polls /api/staff/orders every 15s, plays a looping alarm while any
// PAID order is outstanding, and exposes the staff-allowed transitions:
//
//   PAID       → CONFIRMED        (Accept)         POST /restaurant/orders/:id/accept
//   PAID       → REJECTED…        (Decline)        POST /restaurant/orders/:id/decline
//   CONFIRMED  → PREPARING        (Start prep)     PATCH /staff/orders/:id/status
//   PREPARING  → PACKED           (Mark packed)    PATCH /staff/orders/:id/status

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getStaffOrders,
  staffAcceptOrder,
  staffDeclineOrder,
  staffUpdateOrderStatus,
  type StaffStatusKey,
} from '../../../api/staff';
import { getStaffMe, staffLogout } from '../../../api/staffAuth';
import { clearStaffToken, getStaffToken } from '../../../lib/staffApiClient';
import type { Permissions, Staff, StaffOrder } from '../../../types';

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

export default function StaffOrdersPage() {
  const router = useRouter();

  const [staff, setStaff] = useState<Staff | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [identityChecked, setIdentityChecked] = useState<boolean>(false);
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs (not state) so updating them doesn't re-render and the alarm
  // can be driven from inside polling callbacks without stale closures.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seenPaidRef = useRef<Set<string>>(new Set());
  const unlockBoundRef = useRef<boolean>(false);

  const goLogin = useCallback(() => {
    clearStaffToken();
    router.replace('/staff/login');
  }, [router]);

  // No token → bounce to login. Done in an effect so we render nothing
  // before the redirect.
  useEffect(() => {
    if (!getStaffToken()) {
      goLogin();
    }
  }, [goLogin]);

  // Verify identity + load permissions before kicking off polling.
  useEffect(() => {
    let cancelled = false;
    if (!getStaffToken()) return undefined;
    void (async () => {
      try {
        const me = await getStaffMe();
        if (cancelled) return;
        setStaff(me.staff);
        setPermissions(me.permissions);
        setIdentityChecked(true);
      } catch (err: unknown) {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          goLogin();
          return;
        }
        const e = err as { userMessage?: string | null; message?: string };
        setError(e?.userMessage || e?.message || 'Could not load your account');
        setIdentityChecked(true);
      }
    })();
    return () => { cancelled = true; };
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

  // Initial load + 15s polling. Gated on identity check so we don't
  // fire two parallel requests for an account whose token is already
  // expired. Also gated on view_orders permission — no point polling
  // an endpoint we know the user can't read.
  useEffect(() => {
    if (!identityChecked) return undefined;
    if (permissions && !permissions.view_orders) return undefined;
    let active = true;
    void fetchOrders();
    const id = window.setInterval(() => { if (active) void fetchOrders(); }, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(id);
      stopAlarm();
    };
  }, [fetchOrders, identityChecked, permissions, stopAlarm]);

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

  const onSignOut = async () => {
    stopAlarm();
    // Best-effort logout — never block navigation on it.
    try { await staffLogout(); } catch { /* ignore */ }
    goLogin();
  };

  // Permission shortcuts. Default to false when permissions haven't
  // loaded yet so action buttons don't flash before the /me response.
  const canAccept = permissions?.accept_orders === true;
  const canReject = permissions?.reject_orders === true;
  const canMarkReady = permissions?.mark_ready === true;
  const canViewOrders = permissions?.view_orders !== false;

  return (
    <main className="flex-1 pt-4 px-4 pb-8 max-w-[720px] mx-auto w-full">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="m-0 text-lg font-semibold">Live Orders</h1>
          {staff && (
            <div className="text-xs text-dim mt-1">
              {staff.display_name} · {staff.role_preset}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => { void onSignOut(); }}
          className="py-1 px-3 text-xs bg-transparent border border-rim text-dim rounded-md cursor-pointer"
        >
          Sign out
        </button>
      </header>

      {error && (
        <div className="py-2 px-3 mb-3 bg-red-glow border border-red-stroke text-red-300 rounded-lg text-xs">
          {error}
        </div>
      )}

      {!identityChecked ? (
        <p className="text-dim text-sm">Loading…</p>
      ) : !canViewOrders ? (
        <div className="rounded-lg p-4 border border-rim bg-ink2 text-center">
          <div className="text-base font-semibold mb-1">No access</div>
          <p className="text-dim text-sm">
            You don&apos;t have access to view orders. Ask your restaurant owner
            to enable the &quot;View orders&quot; permission for your account.
          </p>
        </div>
      ) : loading && orders.length === 0 ? (
        <p className="text-dim text-sm">Loading orders…</p>
      ) : orders.length === 0 ? (
        <p className="text-dim text-sm">No active orders right now.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {orders.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              busy={actionPending === o.id}
              canAccept={canAccept}
              canReject={canReject}
              canMarkReady={canMarkReady}
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
  canAccept: boolean;
  canReject: boolean;
  canMarkReady: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onPreparing: () => void;
  onPacked: () => void;
}

function OrderCard({
  order,
  busy,
  canAccept,
  canReject,
  canMarkReady,
  onAccept,
  onDecline,
  onPreparing,
  onPacked,
}: OrderCardProps) {
  const isPaid = order.status === 'PAID';
  const isConfirmed = order.status === 'CONFIRMED';
  const isPreparing = order.status === 'PREPARING';

  return (
    <div className={`rounded-lg p-3 border ${isPaid ? 'bg-red-glow border-red-stroke' : 'bg-ink2 border-rim'}`}>
      <div className="flex justify-between items-baseline gap-2">
        <div>
          <div className="text-base font-semibold">#{order.order_number}</div>
          <div className="text-xs text-dim">
            {order.customer_name} · {order.customer_phone_masked}
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold">₹{order.total_rs}</div>
          <div className="text-xs text-dim">
            {fmtTime(order.created_at)} · {order.status}
          </div>
        </div>
      </div>

      {order.items.length > 0 && (
        <ul className="mt-2 mb-1 p-0 list-none text-xs text-tx">
          {order.items.map((it, i) => (
            <li key={`${order.id}-${i}`}>
              {it.quantity}× {it.name}
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-1 flex-wrap mt-2">
        {isPaid && canAccept && (
          <button
            type="button"
            disabled={busy}
            onClick={onAccept}
            className={`${BTN_BASE_CLS} ${busy ? BTN_BUSY_CLS : 'bg-wa cursor-pointer'}`}
          >
            {busy ? 'Working…' : 'Accept'}
          </button>
        )}
        {isPaid && canReject && (
          <button
            type="button"
            disabled={busy}
            onClick={onDecline}
            className={`${BTN_BASE_CLS} ${busy ? BTN_BUSY_CLS : 'bg-red cursor-pointer'}`}
          >
            Decline
          </button>
        )}
        {isConfirmed && canMarkReady && (
          <button
            type="button"
            disabled={busy}
            onClick={onPreparing}
            className={`${BTN_BASE_CLS} ${busy ? BTN_BUSY_CLS : 'bg-gold cursor-pointer'}`}
          >
            {busy ? 'Working…' : 'Start preparing'}
          </button>
        )}
        {isPreparing && canMarkReady && (
          <button
            type="button"
            disabled={busy}
            onClick={onPacked}
            className={`${BTN_BASE_CLS} ${busy ? BTN_BUSY_CLS : 'bg-blue cursor-pointer'}`}
          >
            {busy ? 'Working…' : 'Mark packed'}
          </button>
        )}
      </div>
    </div>
  );
}

const BTN_BASE_CLS = 'py-2 px-4 text-sm text-white border-0 rounded-md font-semibold';
const BTN_BUSY_CLS = 'bg-rim cursor-default';
