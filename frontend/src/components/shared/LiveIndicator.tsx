'use client';

// Green "● Live" pip rendered when the socket layer is connected.
// Reads its state from SocketProvider context — must therefore be
// rendered as a descendant of <SocketProvider> (i.e. inside the
// dashboard / admin layouts, not in app-root chrome).
//
// Hidden when disconnected so a stale "Live" doesn't mislead the
// merchant. The dashboard's poll-based refresh keeps the data fresh
// even when the socket is down.

import { useSocketContext } from './SocketProvider';

export default function LiveIndicator() {
  const { connected } = useSocketContext();
  if (!connected) return null;
  return (
    <span
      title="Real-time channel connected"
      className="text-green text-[0.72rem] font-semibold whitespace-nowrap"
    >
      ● Live
    </span>
  );
}
