'use client';

// Dashboard new-order alarm. Plays /sounds/new_order.mp3 on a loop while
// any PAID order is outstanding; pauses when the last one is handled.
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
//   - stopAll()
//
// Module-level singletons so multiple mounts share the same audio
// element + outstanding-order set — calling the hook from
// DashboardLayoutClient (just to install the autoplay-unlock listener)
// AND the orders page (to drive playback) is intended.
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
const playingFor = new Set<string>();
// Snapshot of the most recent PAID id set syncWithOrders saw, used so
// the diff can detect orders that were never in playingFor (cleared
// across renders) but should still de-dupe alarms for the same id.
const lastSeenPaidIds = new Set<string>();

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

interface UseNewOrderSoundReturn {
  play: (orderId: string) => void;
  stop: (orderId: string) => void;
  stopAll: () => void;
  // Convenience: pass the currently-loaded orders list, the hook diffs
  // against the previous call and manages the alarm. Pass an empty
  // array (or call stopAll) to silence on unmount.
  syncWithOrders: (orders: Array<Pick<Order, 'id' | 'status'>>) => void;
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
  // — multiple hook mounts share the unlockBound flag.
  useEffect(() => {
    bindUnlock();
  }, []);

  const play = useCallback((orderId: string) => {
    if (!orderId) return;
    if (!enabledRef.current) return;
    playingFor.add(orderId);
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
    playingFor.delete(orderId);
    if (playingFor.size > 0) return; // other orders still outstanding
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
    playingFor.clear();
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
    (orders: Array<Pick<Order, 'id' | 'status'>>) => {
      // Build the current PAID id set.
      const currentPaid = new Set<string>();
      for (const o of orders || []) {
        if (o && o.id && o.status === 'PAID') currentPaid.add(String(o.id));
      }

      // Trigger play() for any PAID id we didn't see in the previous
      // sync. This avoids re-triggering for orders that have been
      // sitting in PAID across many polls.
      for (const id of currentPaid) {
        if (!lastSeenPaidIds.has(id)) play(id);
      }

      // Stop any tracked ringing order that's no longer PAID (accepted,
      // declined, or otherwise transitioned). Iterate a snapshot since
      // stop() mutates the underlying set.
      for (const id of Array.from(playingFor)) {
        if (!currentPaid.has(id)) stop(id);
      }

      // Refresh the snapshot for the next diff.
      lastSeenPaidIds.clear();
      for (const id of currentPaid) lastSeenPaidIds.add(id);
    },
    [play, stop],
  );

  return { play, stop, stopAll, syncWithOrders };
}
