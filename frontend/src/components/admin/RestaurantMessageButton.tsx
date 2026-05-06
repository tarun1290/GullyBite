'use client';

// "Message Restaurant" navbar button (admin side). Opens the
// RestaurantMessageDrawer with a restaurant picker + thread view.
// Same unread-badge pattern as the merchant-side AdminMessageButton.
//
// Unread tracking on the admin side is per-instance: the badge
// counts every reply-from-restaurant event since the drawer last
// closed, regardless of which restaurant sent it. Reset on open.

import { useCallback, useEffect, useRef, useState } from 'react';
import RestaurantMessageDrawer from './RestaurantMessageDrawer';
import { useSocketContext } from '../shared/SocketProvider';
import type { AdminRestaurantMessage } from '../../types';

export default function RestaurantMessageButton() {
  const { lastMessage } = useSocketContext();
  const [open, setOpen] = useState<boolean>(false);
  const [unread, setUnread] = useState<number>(0);
  const initialMessageRef = useRef<typeof lastMessage>(null);

  // Bump the badge on incoming reply while drawer is closed. Don't
  // auto-open admin-side: admins routinely have many restaurants in
  // flight and forcing a drawer over their current screen is more
  // disruptive than it's worth. Just nudge with the badge.
  useEffect(() => {
    if (!lastMessage) return;
    if (initialMessageRef.current === lastMessage) return;
    initialMessageRef.current = lastMessage;
    if (!open) setUnread((n) => n + 1);
  }, [lastMessage, open]);

  useEffect(() => {
    if (open) setUnread(0);
  }, [open]);

  const onThreadLoaded = useCallback((messages: AdminRestaurantMessage[]) => {
    const remaining = messages.filter((m) => m.from === 'restaurant' && m.read === false).length;
    if (remaining > 0) setUnread(remaining);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Message Restaurant"
        className="relative bg-transparent border border-rim rounded-md py-[0.35rem] px-[0.55rem] cursor-pointer text-[0.78rem] text-fg inline-flex items-center gap-[0.3rem]"
      >
        💬 Message Restaurant
        {unread > 0 && (
          <span
            aria-label={`${unread} unread`}
            className="min-w-[18px] h-[18px] py-0 px-[0.35rem] rounded-full bg-red-500 text-white text-[0.65rem] font-bold inline-flex items-center justify-center"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      <RestaurantMessageDrawer open={open} onClose={() => setOpen(false)} onThreadLoaded={onThreadLoaded} />
    </>
  );
}
