'use client';

// Subscribes to the dashboard's socket.io server and surfaces order
// lifecycle events to the caller.
//
// Events received (rooms scoped to `restaurant:<id>` server-side):
//   'order:new'      — new PAID order created
//   'order:updated'  — generic transition (CONFIRMED, PREPARING, ...)
//   'order:paid'     — Razorpay or WhatsApp Native payment confirmed
//
// Optional callbacks let the caller refetch its own list / stats; we
// also pop a brief audio chime on 'order:new'. The chime reuses
// /sounds/new_order.mp3 (already in public/) since /order-chime.mp3
// isn't shipped — the dashboard's existing alarm uses the same file.

import { useCallback, useEffect, useState } from 'react';
import { useSocket } from './useSocket';

export interface OrderNotification {
  orderId: string;
  orderNumber: string | number;
  total: number;
  branchName: string | null;
  customerPhone: string | null;
  createdAt: string;
}

export interface OrderUpdatePayload {
  orderId: string;
  status: string;
  updatedAt: string;
}

export interface OrderPaidPayload {
  orderId: string;
  amount: number | null;
  paidAt: string;
}

interface UseOrderNotificationsOptions {
  onNewOrder?: (order: OrderNotification) => void;
  onUpdated?: (payload: OrderUpdatePayload) => void;
  onPaid?: (payload: OrderPaidPayload) => void;
}

interface UseOrderNotificationsReturn {
  connected: boolean;
  lastOrder: OrderNotification | null;
}

const CHIME_SRC = '/sounds/new_order.mp3';

function playChime(): void {
  if (typeof window === 'undefined') return;
  try {
    const a = new Audio(CHIME_SRC);
    // Don't loop — just a single notification cue. The full looping
    // alarm lives in useNewOrderSound.ts, which the orders page
    // already drives off the polled list. This is just a quick beep
    // on the live event itself.
    void a.play().catch(() => { /* autoplay blocked — fail silently */ });
  } catch { /* ignore */ }
}

export function useOrderNotifications(
  optionsOrCallback?: UseOrderNotificationsOptions | ((order: OrderNotification) => void),
): UseOrderNotificationsReturn {
  // Accept either a single callback (legacy spec shape) or an options
  // object with separate handlers. Both are convenient depending on
  // which page is consuming.
  const opts: UseOrderNotificationsOptions =
    typeof optionsOrCallback === 'function'
      ? { onNewOrder: optionsOrCallback }
      : (optionsOrCallback || {});

  const { onNewOrder, onUpdated, onPaid } = opts;

  const { socket, connected } = useSocket();
  const [lastOrder, setLastOrder] = useState<OrderNotification | null>(null);

  const handleNew = useCallback(
    (data: OrderNotification) => {
      setLastOrder(data);
      playChime();
      if (onNewOrder) onNewOrder(data);
    },
    [onNewOrder],
  );

  const handleUpdated = useCallback(
    (data: OrderUpdatePayload) => {
      if (onUpdated) onUpdated(data);
    },
    [onUpdated],
  );

  const handlePaid = useCallback(
    (data: OrderPaidPayload) => {
      if (onPaid) onPaid(data);
    },
    [onPaid],
  );

  useEffect(() => {
    if (!socket) return;
    socket.on('order:new', handleNew);
    socket.on('order:updated', handleUpdated);
    socket.on('order:paid', handlePaid);
    return () => {
      socket.off('order:new', handleNew);
      socket.off('order:updated', handleUpdated);
      socket.off('order:paid', handlePaid);
    };
  }, [socket, handleNew, handleUpdated, handlePaid]);

  return { connected, lastOrder };
}
