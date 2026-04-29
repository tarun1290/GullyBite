'use client';

// Subscribes to the dashboard's socket.io server and surfaces order,
// admin-action, and admin-feed events to the caller.
//
// Events received (rooms scoped to `restaurant:<id>` server-side, plus
// `admin:platform` for the admin-scoped console):
//   'order:new'                — new PAID order created
//   'order:updated'            — generic transition (CONFIRMED, ...)
//   'order:paid'               — Razorpay/WA Native payment confirmed
//   'admin:action'             — platform admin action affecting this
//                                restaurant (approval, suspension,
//                                wallet credit, verification change).
//                                Toasted as a warning on merchant side.
//   'admin:order_new'          — admin-only live feed: new order at any
//                                tenant. Slimmer payload than 'order:new'.
//   'restaurant:branch_status' — admin-only live feed: a branch toggled
//                                open or closed.
//   'admin:new_signup'         — admin-only live feed: new restaurant
//                                signed up.
//
// The three admin-feed events ride on the `admin:platform` room so
// only sockets that authenticated with an admin JWT will receive them
// (see ec2-server.js io.use). Restaurant clients can attach the
// listeners safely — they just never fire there.
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

export interface AdminActionPayload {
  // 'approval' | 'rejection' | 'suspension' | 'credit' | 'verification' | string
  // Left as string to keep the wire shape forward-compatible — backend
  // can add new types without bumping the frontend type union first.
  type: string;
  message: string;
  amount?: number;
  timestamp: string;
}

// Admin-side live-feed payloads. Emitted to the `admin:platform` room
// only — restaurant-scoped sockets will never receive these even with
// the listeners attached.
export interface AdminOrderNewPayload {
  restaurantId: string;
  orderNumber: string | number;
  total: number;
  branchName: string | null;
}

export interface BranchStatusPayload {
  restaurantId: string;
  branchId: string;
  branchName: string | null;
  is_open: boolean;
}

export interface AdminNewSignupPayload {
  restaurantId: string;
  name: string;
  email: string;
}

// Direct-message event used by the admin↔restaurant DM channel. Emitted
// by both sides — `from` distinguishes which direction. `restaurantId`
// + `restaurantName` are only present on restaurant→admin replies; the
// admin→restaurant emit doesn't echo them since the receiver IS the
// restaurant.
export interface DirectMessagePayload {
  from: 'admin' | string; // 'admin' or the sender restaurantId
  restaurantId?: string;
  restaurantName?: string | null;
  message: string;
  timestamp: string;
}

interface UseOrderNotificationsOptions {
  onNewOrder?: (order: OrderNotification) => void;
  onUpdated?: (payload: OrderUpdatePayload) => void;
  onPaid?: (payload: OrderPaidPayload) => void;
  onAdminAction?: (payload: AdminActionPayload) => void;
  onAdminOrderNew?: (payload: AdminOrderNewPayload) => void;
  onBranchStatus?: (payload: BranchStatusPayload) => void;
  onAdminNewSignup?: (payload: AdminNewSignupPayload) => void;
  onMessage?: (payload: DirectMessagePayload) => void;
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

  const {
    onNewOrder,
    onUpdated,
    onPaid,
    onAdminAction,
    onAdminOrderNew,
    onBranchStatus,
    onAdminNewSignup,
    onMessage,
  } = opts;

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

  const handleAdminAction = useCallback(
    (data: AdminActionPayload) => {
      if (onAdminAction) onAdminAction(data);
    },
    [onAdminAction],
  );

  const handleAdminOrderNew = useCallback(
    (data: AdminOrderNewPayload) => {
      if (onAdminOrderNew) onAdminOrderNew(data);
    },
    [onAdminOrderNew],
  );

  const handleBranchStatus = useCallback(
    (data: BranchStatusPayload) => {
      if (onBranchStatus) onBranchStatus(data);
    },
    [onBranchStatus],
  );

  const handleAdminNewSignup = useCallback(
    (data: AdminNewSignupPayload) => {
      if (onAdminNewSignup) onAdminNewSignup(data);
    },
    [onAdminNewSignup],
  );

  const handleMessage = useCallback(
    (data: DirectMessagePayload) => {
      if (onMessage) onMessage(data);
    },
    [onMessage],
  );

  useEffect(() => {
    if (!socket) return;
    socket.on('order:new', handleNew);
    socket.on('order:updated', handleUpdated);
    socket.on('order:paid', handlePaid);
    socket.on('admin:action', handleAdminAction);
    socket.on('admin:order_new', handleAdminOrderNew);
    socket.on('restaurant:branch_status', handleBranchStatus);
    socket.on('admin:new_signup', handleAdminNewSignup);
    socket.on('message:new', handleMessage);
    return () => {
      socket.off('order:new', handleNew);
      socket.off('order:updated', handleUpdated);
      socket.off('order:paid', handlePaid);
      socket.off('admin:action', handleAdminAction);
      socket.off('admin:order_new', handleAdminOrderNew);
      socket.off('restaurant:branch_status', handleBranchStatus);
      socket.off('admin:new_signup', handleAdminNewSignup);
      socket.off('message:new', handleMessage);
    };
  }, [
    socket,
    handleNew,
    handleUpdated,
    handlePaid,
    handleAdminAction,
    handleAdminOrderNew,
    handleBranchStatus,
    handleAdminNewSignup,
    handleMessage,
  ]);

  return { connected, lastOrder };
}
