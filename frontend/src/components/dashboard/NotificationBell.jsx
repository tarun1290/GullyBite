import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getRestaurantNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '../../api/restaurant.js';

// Per-restaurant notification bell. Polls GET /feedback/notifications
// every 60s — cheap because the endpoint caps at 10 rows. Red badge
// reflects unread count. Dropdown surfaces the last 10 notifications
// with a deep link to the Feedback tab for escalations.
export default function NotificationBell() {
  const [state, setState] = useState({ notifications: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapperRef = useRef(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const data = await getRestaurantNotifications({ limit: 10 });
      setState({ notifications: data?.notifications || [], unread: data?.unread || 0 });
    } catch (_) {
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
    const onClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  async function handleItemClick(n) {
    setBusy(true);
    try {
      if (!n.is_read) await markNotificationRead(n._id);
    } catch (_) { /* non-blocking */ }
    setBusy(false);
    setOpen(false);
    await load();
    if (n.type === 'feedback_escalation' || n.type === 'feedback_positive') {
      navigate('/dashboard/feedback');
    }
  }

  async function handleReadAll() {
    setBusy(true);
    try {
      await markAllNotificationsRead();
    } catch (_) { /* non-blocking */ }
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
        <span style={{ fontSize: '1.05rem' }}>{'\uD83D\uDD14'}</span>
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
                      {isEscalation ? '\u26A0\uFE0F' : '\u2B50'}
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
                      {n.body.length > 120 ? `${n.body.slice(0, 120)}\u2026` : n.body}
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
