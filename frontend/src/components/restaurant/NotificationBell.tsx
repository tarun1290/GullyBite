'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getRestaurantNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '../../api/restaurant';
import type { Notification } from '../../types';

// API row uses Mongo's `_id` and `is_read`; the shared Notification type
// has `id` + `read`. Define a loose form for what the endpoint returns.
type ApiNotification = Notification & {
  _id: string;
  is_read?: boolean;
  type?: string;
};

interface NotificationsResponse {
  notifications?: ApiNotification[];
  unread?: number;
}

interface NotificationState {
  notifications: ApiNotification[];
  unread: number;
}

export default function NotificationBell() {
  const [state, setState] = useState<NotificationState>({ notifications: [], unread: 0 });
  const [open, setOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const raw = await getRestaurantNotifications({ limit: 10 });
      const data = raw as NotificationsResponse | null | undefined;
      setState({ notifications: data?.notifications || [], unread: data?.unread || 0 });
    } catch (_e) {
      // Swallow transient errors so the bell never blocks the dashboard.
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60 * 1000);
    return () => clearInterval(iv);
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  async function handleItemClick(n: ApiNotification) {
    setBusy(true);
    try {
      if (!n.is_read) await markNotificationRead(n._id);
    } catch (_e) { /* non-blocking */ }
    setBusy(false);
    setOpen(false);
    await load();
    if (n.type === 'feedback_escalation' || n.type === 'feedback_positive') {
      router.push('/dashboard/feedback');
    }
  }

  async function handleReadAll() {
    setBusy(true);
    try {
      await markAllNotificationsRead();
    } catch (_e) { /* non-blocking */ }
    setBusy(false);
    await load();
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        className="relative border border-rim bg-white rounded-full w-9 h-9 inline-flex items-center justify-center cursor-pointer"
      >
        <span className="text-[1.05rem]">🔔</span>
        {state.unread > 0 && (
          <span className="absolute -top-1 -right-1 bg-[#ef4444] text-white rounded-full text-[0.65rem] font-bold min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center">
            {state.unread > 99 ? '99+' : state.unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-[calc(100%+6px)] right-0 w-80 bg-white border border-rim rounded-r shadow-[0_8px_22px_rgba(0,0,0,0.08)] z-50 max-h-[420px] overflow-hidden flex flex-col">
          <div className="py-[0.65rem] px-[0.8rem] flex items-center justify-between border-b border-rim bg-panel">
            <strong className="text-[0.88rem]">Notifications</strong>
            <button
              type="button"
              disabled={busy || state.unread === 0}
              onClick={handleReadAll}
              className={`bg-none border-0 text-[0.76rem] ${state.unread === 0 ? 'text-dim cursor-default' : 'text-primary cursor-pointer'}`}
            >
              Mark all read
            </button>
          </div>
          <div className="overflow-y-auto">
            {state.notifications.length === 0 && (
              <div className="p-4 text-[0.84rem] text-dim">
                No notifications yet.
              </div>
            )}
            {state.notifications.map((n) => {
              const isEscalation = n.type === 'feedback_escalation';
              return (
                <button
                  key={n._id}
                  type="button"
                  onClick={() => handleItemClick(n)}
                  className={`block w-full text-left py-[0.65rem] px-[0.8rem] border-0 border-b border-rim cursor-pointer ${n.is_read ? 'bg-white' : 'bg-[#fff7ed]'}`}
                >
                  <div className="flex items-center gap-[0.4rem]">
                    <span className="text-[0.95rem]">
                      {isEscalation ? '⚠️' : '⭐'}
                    </span>
                    <strong className={`text-[0.82rem] ${isEscalation ? 'text-[#b45309]' : 'text-inherit'}`}>
                      {n.title}
                    </strong>
                  </div>
                  {n.body && (
                    <div className="text-[0.76rem] text-dim mt-[0.2rem]">
                      {n.body.length > 120 ? `${n.body.slice(0, 120)}…` : n.body}
                    </div>
                  )}
                  <div className="text-[0.7rem] text-dim mt-[0.2rem]">
                    {n.created_at ? new Date(n.created_at).toLocaleString() : ''}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
