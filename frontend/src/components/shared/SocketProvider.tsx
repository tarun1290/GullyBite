'use client';

// Global socket-event surface for the dashboard. Mounted once in
// app/dashboard/layout.tsx and app/admin/layout.tsx so every page in
// either tree shares ONE socket connection — eliminates the prior
// problem where each consumer page constructed its own io() client.
//
// Pages read events via useSocketContext():
//   { connected, lastOrder, lastUpdated, lastPaid, lastAdminAction,
//     lastAdminFeedEvent }
//
// All `last*` fields are payload references that change identity on
// each new event — consumers attach a useEffect with the payload as a
// dep to react exactly once per event without juggling callbacks. The
// reference only mutates when a new event lands, so this is stable
// across normal re-renders.
//
// Toasts:
//   • 'new_order'                 → green success ("New order #N — ₹X")
//   • 'admin_action'              → amber warning (server message)
//   • 'admin_order_new'           → blue info  (admin tree only)
//   • 'restaurant_branch_status'  → blue info  (admin tree only)
//   • 'admin_new_signup'          → blue info  (admin tree only)
//
// Auth: useSocket falls back from `zm_token` to `gb_admin_token` so
// both layout trees authenticate. The backend's io.use middleware
// joins admins to `admin:platform` and restaurants to
// `restaurant:<id>` — the three admin-feed events ride on the admin
// room, so a restaurant-side listener attaches but never fires.
//
// `isAdmin` prop: gates the admin-feed toasts at the consumer side so
// the dashboard tree doesn't toast events it would never receive
// anyway. Cosmetic but keeps the dashboard's UI surface clean.

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { useToast } from '../Toast';
import {
  useOrderNotifications,
  type AdminActionPayload,
  type AdminNewSignupPayload,
  type AdminOrderNewPayload,
  type BranchStatusPayload,
  type DeliveryUpdatePayload,
  type DirectMessagePayload,
  type OrderNotification,
  type OrderPaidPayload,
  type OrderUpdatePayload,
  type RiderLocationPayload,
  type StatsDelta,
} from '../../hooks/useOrderNotifications';

// Discriminated union of admin-feed events. Stored as the most-recent
// admin-feed payload so admin pages can react to a single context
// field rather than 3 separate ones.
export type AdminFeedEvent =
  | { kind: 'order_new'; data: AdminOrderNewPayload; receivedAt: string }
  | { kind: 'branch_status'; data: BranchStatusPayload; receivedAt: string }
  | { kind: 'new_signup'; data: AdminNewSignupPayload; receivedAt: string };

interface SocketContextValue {
  connected: boolean;
  lastOrder: OrderNotification | null;
  lastUpdated: OrderUpdatePayload | null;
  lastPaid: OrderPaidPayload | null;
  lastAdminAction: AdminActionPayload | null;
  lastAdminFeedEvent: AdminFeedEvent | null;
  // Latest direct-message event in either direction. Reference identity
  // changes per event so consumers can `useEffect` on it to react. The
  // restaurant-side drawer auto-opens; the admin-side drawer bumps an
  // unread badge unless the matching thread is already open.
  lastMessage: DirectMessagePayload | null;
  // Latest rider-position update from the Prorouting Track Callback.
  // Per-restaurant scope; consumers (e.g. RiderLocationCard) filter by
  // order_id since multiple orders can be in flight per branch. Reference
  // identity changes per event for the same useEffect-on-payload pattern
  // used by other lastX fields.
  lastRiderLocation: RiderLocationPayload | null;
  // Latest Prorouting state-machine update — fires after every
  // prorouting_state $set on the backend (services/proroutingState.js).
  // Consumers (orders page) attach a useEffect on this reference and
  // silentRefetch() so the DeliveryTimeline rerenders with the freshest
  // stamps. Filtering by orderId happens at the consumer side since
  // multiple orders can be progressing through the state machine in
  // parallel.
  lastDeliveryUpdate: DeliveryUpdatePayload | null;
  // Live-stats delta from the most recent new_paid_order (ref changes
  // per event). Consumers useEffect on it to optimistically bump
  // headline counters without an API round-trip.
  lastDelta: StatsDelta | null;
  // Monotonic counter: bumps on every new_paid_order /
  // order_status_changed. Consumers useEffect on it to resync stats.
  statsVersion: number;
}

const SocketContext = createContext<SocketContextValue | null>(null);

interface SocketProviderProps {
  children: ReactNode;
  // Set true on the admin layout tree. When false (dashboard tree)
  // the admin-feed toasts never fire — the events themselves don't
  // arrive on a non-admin socket but this skips the listener-attach
  // and toast machinery entirely.
  isAdmin?: boolean;
}

export function SocketProvider({ children, isAdmin = false }: SocketProviderProps) {
  const { showToast } = useToast();
  const [lastOrder, setLastOrder] = useState<OrderNotification | null>(null);
  const [lastUpdated, setLastUpdated] = useState<OrderUpdatePayload | null>(null);
  const [lastPaid, setLastPaid] = useState<OrderPaidPayload | null>(null);
  const [lastAdminAction, setLastAdminAction] = useState<AdminActionPayload | null>(null);
  const [lastAdminFeedEvent, setLastAdminFeedEvent] = useState<AdminFeedEvent | null>(null);
  const [lastMessage, setLastMessage] = useState<DirectMessagePayload | null>(null);
  const [lastRiderLocation, setLastRiderLocation] = useState<RiderLocationPayload | null>(null);
  const [lastDeliveryUpdate, setLastDeliveryUpdate] = useState<DeliveryUpdatePayload | null>(null);

  // Each callback is useCallback-wrapped so its identity is stable
  // across SocketProvider re-renders. Without this, inline arrows
  // produced a new reference per render, the consumer hook's effect
  // deps changed every render, and socket.off/on cycled on every
  // pass — a brief window where inbound events could land while no
  // handler was attached. showToast is already useCallback-stable
  // upstream (Toast.tsx); useState setters are inherently stable.
  const onNewOrder = useCallback((order: OrderNotification) => {
    // One toast per new order, fired centrally so it lands regardless
    // of which page the merchant is viewing. Format matches what the
    // orders page used to emit so users don't see a wording change
    // when this layer takes over.
    showToast(`New order #${order.orderNumber} — ₹${order.totalRs}`, 'success');
    setLastOrder(order);
  }, [showToast]);

  const onUpdated = useCallback((payload: OrderUpdatePayload) => {
    setLastUpdated(payload);
  }, []);

  const onPaid = useCallback((payload: OrderPaidPayload) => {
    setLastPaid(payload);
  }, []);

  const onAdminAction = useCallback((payload: AdminActionPayload) => {
    // Distinguish from order events with the warning style — these
    // are platform-side actions (suspension, approval, refund,
    // verification) the merchant needs to acknowledge, not routine
    // order activity. Server-supplied message is displayed verbatim.
    showToast(payload.message, 'warning');
    setLastAdminAction(payload);
  }, [showToast]);

  const onAdminOrderNew = useCallback((payload: AdminOrderNewPayload) => {
    const branch = payload.branchName ? ` at ${payload.branchName}` : '';
    showToast(`New order${branch} — ₹${payload.total}`, 'info');
    setLastAdminFeedEvent({ kind: 'order_new', data: payload, receivedAt: new Date().toISOString() });
  }, [showToast]);

  const onBranchStatus = useCallback((payload: BranchStatusPayload) => {
    const name = payload.branchName || 'A branch';
    const state = payload.is_open ? 'open' : 'closed';
    showToast(`${name} is now ${state}`, 'info');
    setLastAdminFeedEvent({ kind: 'branch_status', data: payload, receivedAt: new Date().toISOString() });
  }, [showToast]);

  const onAdminNewSignup = useCallback((payload: AdminNewSignupPayload) => {
    showToast(`New restaurant signup: ${payload.name}`, 'info');
    setLastAdminFeedEvent({ kind: 'new_signup', data: payload, receivedAt: new Date().toISOString() });
  }, [showToast]);

  // Direct-message thread between admin and a specific restaurant.
  // Toast wording is side-aware: admin sees "Reply from <name>"
  // (sender is a restaurant), merchant sees "Message from Admin"
  // (sender is admin). Drawers consume `lastMessage` from context
  // for auto-open / unread-bump behaviour.
  const onMessage = useCallback((payload: DirectMessagePayload) => {
    if (isAdmin) {
      const who = payload.restaurantName || payload.from || 'restaurant';
      showToast(`Reply from ${who}`, 'info');
    } else {
      showToast('Message from Admin', 'info');
    }
    setLastMessage(payload);
  }, [isAdmin, showToast]);

  // No toast for rider location — these fire every few seconds while
  // a delivery is in flight and would spam the UI. Consumers
  // (RiderLocationCard) read lastRiderLocation directly and filter
  // by order_id.
  const onRiderLocation = useCallback((payload: RiderLocationPayload) => {
    setLastRiderLocation(payload);
  }, []);

  // No toast for delivery-state updates — the timeline UI itself is
  // the visible signal. The DeliveryTimeline component re-renders when
  // the orders list refetches; consumers (orders page) attach a
  // useEffect on lastDeliveryUpdate and call silentRefetch() to
  // refresh the underlying list.
  const onDeliveryUpdate = useCallback((payload: DeliveryUpdatePayload) => {
    setLastDeliveryUpdate(payload);
  }, []);

  const { connected, lastDelta, statsVersion } = useOrderNotifications({
    onNewOrder,
    onUpdated,
    onPaid,
    onAdminAction,
    // Admin-feed callbacks are wired only on the admin tree. On the
    // restaurant dashboard these never fire (server-side room scope)
    // but skipping them avoids attaching unused listeners.
    onAdminOrderNew: isAdmin ? onAdminOrderNew : undefined,
    onBranchStatus: isAdmin ? onBranchStatus : undefined,
    onAdminNewSignup: isAdmin ? onAdminNewSignup : undefined,
    onMessage,
    onRiderLocation,
    onDeliveryUpdate,
  });

  return (
    <SocketContext.Provider
      value={{
        connected,
        lastOrder,
        lastUpdated,
        lastPaid,
        lastAdminAction,
        lastAdminFeedEvent,
        lastMessage,
        lastRiderLocation,
        lastDeliveryUpdate,
        lastDelta,
        statsVersion,
      }}
    >
      {children}
    </SocketContext.Provider>
  );
}

export function useSocketContext(): SocketContextValue {
  const ctx = useContext(SocketContext);
  if (!ctx) {
    throw new Error('useSocketContext must be used within a SocketProvider');
  }
  return ctx;
}
