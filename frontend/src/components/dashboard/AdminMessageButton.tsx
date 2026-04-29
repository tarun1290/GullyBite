'use client';

// "Messages from GullyBite" navbar button — opens the AdminMessageDrawer
// and shows an unread badge. Auto-opens the drawer the first time a
// new admin → restaurant message arrives via SocketProvider so the
// merchant doesn't miss it. Subsequent messages while the drawer is
// open are picked up by the drawer's own refetch effect; subsequent
// messages while it's closed bump the unread count.
//
// Unread tracking is local — incremented on each new socket payload
// while the drawer is closed, reset to 0 when the drawer opens (the
// GET endpoint marks rows read=true server-side so the next session
// starts at 0 too).

import { useCallback, useEffect, useRef, useState } from 'react';
import AdminMessageDrawer from './AdminMessageDrawer';
import { useSocketContext } from '../shared/SocketProvider';
import type { AdminRestaurantMessage } from '../../types';

export default function AdminMessageButton() {
  const { lastMessage } = useSocketContext();
  const [open, setOpen] = useState<boolean>(false);
  const [unread, setUnread] = useState<number>(0);
  const initialMessageRef = useRef<typeof lastMessage>(null);

  // Bump the badge when a new message:new arrives while the drawer
  // is closed. Skip the very first effect call (initialMessageRef
  // captures the value at mount) so we don't double-count an event
  // that landed before this component mounted.
  useEffect(() => {
    if (!lastMessage) return;
    if (initialMessageRef.current === lastMessage) return;
    initialMessageRef.current = lastMessage;
    if (!open) {
      // Auto-open the first time a message lands — spec'd UX so the
      // merchant can't miss a platform message.
      setOpen(true);
    }
  }, [lastMessage, open]);

  // Increment unread whenever the drawer is closed and a new message
  // event arrives. The drawer-closed path is rare (since auto-open
  // fires on the first one) but still possible if the merchant
  // dismisses the drawer between two rapid messages.
  useEffect(() => {
    if (!lastMessage || open) return;
    setUnread((n) => n + 1);
  }, [lastMessage, open]);

  // Reset unread + clear server-side read state when the drawer opens.
  // Server clears rows on the GET inside the drawer; we reset the
  // local counter immediately so the badge disappears as soon as the
  // drawer slides in.
  useEffect(() => {
    if (open) setUnread(0);
  }, [open]);

  // Drawer hands us its loaded thread so we can derive the *initial*
  // unread count when the drawer first opens — covers the case where
  // unread events landed between sessions (server-side rows still
  // marked read:false). After this fires, fetchThread inside the
  // drawer marks them all read so subsequent loads return 0 unread.
  const onThreadLoaded = useCallback((messages: AdminRestaurantMessage[]) => {
    const remaining = messages.filter((m) => m.from === 'admin' && m.read === false).length;
    if (remaining > 0) setUnread(remaining);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Messages from GullyBite"
        style={{
          position: 'relative',
          background: 'transparent',
          border: '1px solid var(--rim,#e5e7eb)',
          borderRadius: 6,
          padding: '.35rem .55rem',
          cursor: 'pointer',
          fontSize: '.78rem',
          color: 'var(--fg, inherit)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '.3rem',
        }}
      >
        💬 Messages
        {unread > 0 && (
          <span
            aria-label={`${unread} unread`}
            style={{
              minWidth: 18,
              height: 18,
              padding: '0 .35rem',
              borderRadius: 9,
              background: 'var(--gb-red-500,#dc2626)',
              color: 'white',
              fontSize: '.65rem',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      <AdminMessageDrawer open={open} onClose={() => setOpen(false)} onThreadLoaded={onThreadLoaded} />
    </>
  );
}
