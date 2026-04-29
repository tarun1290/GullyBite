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
//   • 'order:new'                 → green success ("New order #N — ₹X")
//   • 'admin:action'              → amber warning (server message)
//   • 'admin:order_new'           → blue info  (admin tree only)
//   • 'restaurant:branch_status'  → blue info  (admin tree only)
//   • 'admin:new_signup'          → blue info  (admin tree only)
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
  type DirectMessagePayload,
  type OrderNotification,
  type OrderPaidPayload,
  type OrderUpdatePayload,
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

  const { connected } = useOrderNotifications({
    onNewOrder: (order) => {
      // One toast per new order, fired centrally so it lands regardless
      // of which page the merchant is viewing. Format matches what the
      // orders page used to emit so users don't see a wording change
      // when this layer takes over.
      showToast(`New order #${order.orderNumber} — ₹${order.total}`, 'success');
      setLastOrder(order);
    },
    onUpdated: (payload) => setLastUpdated(payload),
    onPaid: (payload) => setLastPaid(payload),
    onAdminAction: (payload) => {
      // Distinguish from order events with the warning style — these
      // are platform-side actions (suspension, approval, refund,
      // verification) the merchant needs to acknowledge, not routine
      // order activity. Server-supplied message is displayed verbatim.
      showToast(payload.message, 'warning');
      setLastAdminAction(payload);
    },
    // Admin-feed callbacks are wired only on the admin tree. On the
    // restaurant dashboard these never fire (server-side room scope)
    // but skipping them avoids attaching unused listeners.
    onAdminOrderNew: isAdmin
      ? (payload) => {
          const branch = payload.branchName ? ` at ${payload.branchName}` : '';
          showToast(`New order${branch} — ₹${payload.total}`, 'info');
          setLastAdminFeedEvent({ kind: 'order_new', data: payload, receivedAt: new Date().toISOString() });
        }
      : undefined,
    onBranchStatus: isAdmin
      ? (payload) => {
          const name = payload.branchName || 'A branch';
          const state = payload.is_open ? 'open' : 'closed';
          showToast(`${name} is now ${state}`, 'info');
          setLastAdminFeedEvent({ kind: 'branch_status', data: payload, receivedAt: new Date().toISOString() });
        }
      : undefined,
    onAdminNewSignup: isAdmin
      ? (payload) => {
          showToast(`New restaurant signup: ${payload.name}`, 'info');
          setLastAdminFeedEvent({ kind: 'new_signup', data: payload, receivedAt: new Date().toISOString() });
        }
      : undefined,
    // Direct-message thread between admin and a specific restaurant.
    // Toast wording is side-aware: the admin sees "Reply from <name>"
    // (sender is a restaurant), the merchant sees "Message from Admin"
    // (sender is admin). Drawers consume `lastMessage` from context
    // for auto-open / unread-bump behaviour.
    onMessage: (payload) => {
      if (isAdmin) {
        const who = payload.restaurantName || payload.from || 'restaurant';
        showToast(`Reply from ${who}`, 'info');
      } else {
        showToast('Message from Admin', 'info');
      }
      setLastMessage(payload);
    },
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
