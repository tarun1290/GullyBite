'use client';

// Dashboard new-order alarm. Plays /sounds/new_order.mp3 on a loop while
// any pending-merchant-action order is outstanding; pauses when the last
// one is handled. "Pending" here = order.status === 'PAID' (paid by
// customer, awaiting accept/decline). PENDING-status orders are
// pre-payment and don't need merchant attention yet.
//
// Why a hook even though there's no event source: the dashboard has no
// SSE / WebSocket client. The orders page polls every 30s. So this hook
// exposes:
//   - syncWithOrders(orders)  — diff the polled list against last call;
//                               start alarm for new PAID ids, stop for
//                               ones that left PAID
//   - play(orderId) / stop(orderId)  — imperative escapes for callsites
//                               that already know what changed (e.g.
//                               the accept/decline handler)
//   - markOrderActioned(orderId) — alias for stop(); used by the
//                               accept/decline handlers so the call site
//                               reads as the user intent rather than
//                               an audio-control verb
//   - stopAll()
//
// Module-level singletons so multiple mounts share the same audio
// element + outstanding-order set — calling the hook from
// DashboardLayoutClient (just to install the autoplay-unlock listener)
// AND the orders page (to drive playback) is intended. A useRef would
// be per-instance and break that sharing.
//
// Autoplay policy: Chrome blocks Audio.play() until the user has
// interacted with the page. We install one-shot pointerdown/keydown
// listeners on document; the first event triggers audio.load(), which
// counts as the gesture-unlock for subsequent .play() calls without
// actually emitting a sound.

import { useCallback, useEffect, useRef } from 'react';
import { useRestaurant } from '../contexts/RestaurantContext';
import type { Order } from '../types';

const AUDIO_SRC = '/sounds/new_order.mp3';

let audioEl: HTMLAudioElement | null = null;
let unlockBound = false;
// Orders that are currently in the action-required state and driving
// the alarm. The alarm loop runs while this set is non-empty and stops
// on the call that empties it. Module-level so the orders page and
// DashboardLayoutClient share the same outstanding set across mounts.
const pendingOrderIds = new Set<string>();
// Snapshot of the action-required id set the previous syncWithOrders
// call saw. Used to diff: an id present now but not last time = a
// genuinely new arrival that should start the alarm. Without this, the
// 30s poll would re-trigger play() for the same outstanding orders on
// every tick.
const lastSeenPendingIds = new Set<string>();

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!audioEl) {
    try {
      audioEl = new Audio(AUDIO_SRC);
      audioEl.loop = true;
      audioEl.preload = 'auto';
    } catch (err) {
      console.warn('[Alarm] Audio init failed:', err);
      return null;
    }
  }
  return audioEl;
}

function unlock() {
  // Calling .load() inside a user-gesture handler counts as the
  // unlock for subsequent .play() calls — and produces no sound.
  try { ensureAudio()?.load(); } catch (err) { console.warn('[Alarm] Unlock failed:', err); }
  if (typeof document !== 'undefined') {
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('keydown', unlock);
  }
}

function bindUnlock() {
  if (unlockBound || typeof document === 'undefined') return;
  unlockBound = true;
  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
}

// ── Foreground Notification API integration ─────────────────────
// Foreground only — no Web Push / VAPID / service-worker push subscription
// here. The SW gates (controller + active registration) ensure the
// dashboard is running as an installed PWA with a working SW before we
// surface the prompt: standalone Android Chrome silently drops
// notifications when the SW isn't active, so prompting in that state
// would burn the user's one-shot allow/deny choice on a config that
// wouldn't deliver. Browsers without an SW would technically still show
// foreground notifications, but we wait for the installed-PWA env.

let notificationPermissionBound = false;

async function maybeRequestNotificationPermission() {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  // Two-gate check before showing the permission prompt:
  //   1. controller non-null — an SW is currently controlling this page
  //      (rejects uncontrolled first-loads before the SW takes over).
  //   2. registration.active non-null — an active SW registration
  //      exists. Required for standalone-PWA notification delivery on
  //      Android Chrome: without an active SW, the granted permission
  //      can resolve but notifications fail to display when the app is
  //      installed and running standalone. Both gates must pass.
  // The function is async because getRegistration() returns a Promise;
  // installing it as a {once:true} listener still works — the listener
  // dispatches synchronously and the async body runs to completion.
  if (!navigator.serviceWorker.controller) return;
  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await navigator.serviceWorker.getRegistration();
  } catch {
    return;
  }
  if (!registration?.active) return;
  if (Notification.permission !== 'default') return;
  try {
    void Notification.requestPermission();
  } catch (err) {
    console.warn('[Alarm] Notification.requestPermission failed:', err);
  }
}

function bindNotificationPermission() {
  if (notificationPermissionBound || typeof document === 'undefined') return;
  notificationPermissionBound = true;
  // Same gesture pattern as the audio unlock — modern browsers also
  // require a user gesture for the permission prompt to surface
  // reliably. {once:true} cleans up after first event of either kind.
  document.addEventListener('pointerdown', maybeRequestNotificationPermission, { once: true });
  document.addEventListener('keydown', maybeRequestNotificationPermission, { once: true });
}

function showNewOrderNotification(displayId: string) {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification('New Order', {
      body: `Order #${displayId} received — tap to open`,
      icon: '/icons/icon-192x192.png',
      requireInteraction: true,
    });
    n.onclick = () => {
      try { window.focus(); } catch { /* focus may be blocked — ignore */ }
      n.close();
    };
  } catch (err) {
    console.warn('[Alarm] Notification show failed:', err);
  }
}

// Shape syncWithOrders accepts. id+status drive the alarm diff;
// display_id / order_number are read for the system notification body
// when an order first arrives. Both display fields are optional — we
// fall back through display_id → order_number → id so callers don't
// have to normalise the order shape before passing it in.
type SyncOrder = Pick<Order, 'id' | 'status'> & {
  display_id?: string | number;
  order_number?: string | number;
};

interface UseNewOrderSoundReturn {
  play: (orderId: string) => void;
  stop: (orderId: string) => void;
  // Semantic alias for stop(orderId). Use this from accept/decline /
  // timeout handlers so the call site reads as the user-intent verb
  // ("this order has been actioned") rather than the audio-control
  // verb. Identical effect: removes the id from pendingOrderIds and
  // pauses the alarm if that drops the set to empty.
  markOrderActioned: (orderId: string) => void;
  stopAll: () => void;
  // Convenience: pass the currently-loaded orders list, the hook diffs
  // against the previous call and manages the alarm. Pass an empty
  // array (or call stopAll) to silence on unmount.
  syncWithOrders: (orders: SyncOrder[]) => void;
}

interface RestaurantWithNotify {
  notification_settings?: { new_order?: boolean } | null;
}

export function useNewOrderSound(): UseNewOrderSoundReturn {
  const restaurantCtx = useRestaurant();
  const restaurant = restaurantCtx?.restaurant as RestaurantWithNotify | null | undefined;
  // Default to ON when the preference is missing or true. Only an
  // explicit false silences the alarm.
  const enabled = restaurant?.notification_settings?.new_order !== false;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Install the document-level autoplay-unlock listener once. Idempotent
  // — multiple hook mounts share the unlockBound flag. Same call site
  // wires the one-time Notification.requestPermission() prompt off the
  // next user gesture; both bindings are no-ops after the first call.
  useEffect(() => {
    bindUnlock();
    bindNotificationPermission();
  }, []);

  const play = useCallback((orderId: string) => {
    if (!orderId) return;
    if (!enabledRef.current) return;
    pendingOrderIds.add(orderId);
    const a = ensureAudio();
    if (!a) return;
    if (!a.paused) return; // already ringing
    try {
      a.currentTime = 0;
      a.play().catch((err) => console.warn('[Alarm] Play failed:', err));
    } catch (err) {
      console.warn('[Alarm] Play threw:', err);
    }
  }, []);

  const stop = useCallback((orderId: string) => {
    if (!orderId) return;
    pendingOrderIds.delete(orderId);
    if (pendingOrderIds.size > 0) return; // other orders still outstanding
    const a = audioEl;
    if (!a) return;
    try {
      a.pause();
      a.currentTime = 0;
    } catch (err) {
      console.warn('[Alarm] Stop failed:', err);
    }
  }, []);

  const stopAll = useCallback(() => {
    pendingOrderIds.clear();
    const a = audioEl;
    if (!a) return;
    try {
      a.pause();
      a.currentTime = 0;
    } catch (err) {
      console.warn('[Alarm] StopAll failed:', err);
    }
  }, []);

  const syncWithOrders = useCallback(
    (orders: SyncOrder[]) => {
      // Single pass: collect the current PAID id set AND fire side
      // effects for ids that are new since the last sync. Doing it in
      // one loop lets us read order.display_id / order_number at the
      // moment we trigger the per-order Notification, without keeping
      // a parallel id→displayId map.
      const currentPaid = new Set<string>();
      for (const o of orders || []) {
        if (!o || !o.id || o.status !== 'PAID') continue;
        const id = String(o.id);
        currentPaid.add(id);
        if (lastSeenPendingIds.has(id)) continue;
        play(id);
        const display = o.display_id != null
          ? String(o.display_id)
          : o.order_number != null
            ? String(o.order_number)
            : id;
        showNewOrderNotification(display);
      }

      // Stop any tracked ringing order that's no longer PAID (accepted,
      // declined, or otherwise transitioned). Iterate a snapshot since
      // stop() mutates the underlying set.
      for (const id of Array.from(pendingOrderIds)) {
        if (!currentPaid.has(id)) stop(id);
      }

      // Refresh the snapshot for the next diff.
      lastSeenPendingIds.clear();
      for (const id of currentPaid) lastSeenPendingIds.add(id);
    },
    [play, stop],
  );

  return { play, stop, markOrderActioned: stop, stopAll, syncWithOrders };
}
