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
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        style={{
          position: 'relative',
          border: '1px solid var(--rim)',
          background: '#fff',
          borderRadius: '999px',
          width: 36, height: 36,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: '1.05rem' }}>🔔</span>
        {state.unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -4, right: -4,
              background: '#ef4444',
              color: '#fff',
              borderRadius: '999px',
              fontSize: '.65rem',
              fontWeight: 700,
              minWidth: 18, height: 18,
              padding: '0 4px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {state.unread > 99 ? '99+' : state.unread}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: 320,
            background: '#fff',
            border: '1px solid var(--rim)',
            borderRadius: 'var(--r)',
            boxShadow: '0 8px 22px rgba(0,0,0,.08)',
            zIndex: 50,
            maxHeight: 420,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '.65rem .8rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid var(--rim)',
              background: 'var(--panel)',
            }}
          >
            <strong style={{ fontSize: '.88rem' }}>Notifications</strong>
            <button
              type="button"
              disabled={busy || state.unread === 0}
              onClick={handleReadAll}
              style={{
                background: 'none',
                border: 'none',
                color: state.unread === 0 ? 'var(--dim)' : 'var(--primary, #0369a1)',
                fontSize: '.76rem',
                cursor: state.unread === 0 ? 'default' : 'pointer',
              }}
            >
              Mark all read
            </button>
          </div>
          <div style={{ overflowY: 'auto' }}>
            {state.notifications.length === 0 && (
              <div style={{ padding: '1rem', fontSize: '.84rem', color: 'var(--dim)' }}>
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
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '.65rem .8rem',
                    border: 'none',
                    borderBottom: '1px solid var(--rim)',
                    background: n.is_read ? '#fff' : '#fff7ed',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                    <span style={{ fontSize: '.95rem' }}>
                      {isEscalation ? '⚠️' : '⭐'}
                    </span>
                    <strong
                      style={{
                        fontSize: '.82rem',
                        color: isEscalation ? '#b45309' : 'inherit',
                      }}
                    >
                      {n.title}
                    </strong>
                  </div>
                  {n.body && (
                    <div style={{ fontSize: '.76rem', color: 'var(--dim)', marginTop: '.2rem' }}>
                      {n.body.length > 120 ? `${n.body.slice(0, 120)}…` : n.body}
                    </div>
                  )}
                  <div style={{ fontSize: '.7rem', color: 'var(--dim)', marginTop: '.2rem' }}>
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
