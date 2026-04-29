'use client';

// Admin-side drawer for the admin↔restaurant DM thread. Lets a
// platform admin pick a restaurant and read/reply within a single
// thread. Mounted in AdminLayoutClient's navbar `actions` slot.
//
// Auto-select on incoming reply: when SocketProvider's `lastMessage`
// fires AND the payload's restaurantId differs from the active
// thread, the drawer auto-switches to that thread and refreshes — so
// admins on the drawer can react to any reply without manually
// hunting for the restaurant.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SlideOverDrawer from '../shared/SlideOverDrawer';
import { useSocketContext } from '../shared/SocketProvider';
import { useToast } from '../Toast';
import { getAdminMessageThread, getAdminRestaurants, sendAdminMessage } from '../../api/admin';
import type { AdminRestaurant, AdminRestaurantMessage } from '../../types';

function fmtTime(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

interface RestaurantMessageDrawerProps {
  open: boolean;
  onClose: () => void;
  // Lets the navbar mount point read the latest incoming-but-unseen
  // count so it can render an unread badge. Passed the active thread's
  // messages on every refetch.
  onThreadLoaded?: (messages: AdminRestaurantMessage[]) => void;
}

export default function RestaurantMessageDrawer({ open, onClose, onThreadLoaded }: RestaurantMessageDrawerProps) {
  const { showToast } = useToast();
  const { lastMessage } = useSocketContext();
  const [restaurants, setRestaurants] = useState<AdminRestaurant[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AdminRestaurantMessage[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [text, setText] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const onThreadLoadedRef = useRef(onThreadLoaded);
  onThreadLoadedRef.current = onThreadLoaded;

  // Load the restaurants list once when the drawer first opens. Cached
  // for the lifetime of this component — admins almost never need a
  // fresh restaurants list mid-thread, and the dashboard's main page
  // already refreshes when they navigate elsewhere.
  useEffect(() => {
    if (!open || restaurants.length) return;
    let alive = true;
    (async () => {
      try {
        const list = await getAdminRestaurants();
        if (alive) setRestaurants(Array.isArray(list) ? list : []);
      } catch {
        if (alive) showToast('Failed to load restaurants', 'error');
      }
    })();
    return () => { alive = false; };
  }, [open, restaurants.length, showToast]);

  const fetchThread = useCallback(async (rid: string) => {
    if (!rid) return;
    setLoading(true);
    try {
      const res = await getAdminMessageThread(rid);
      const arr = Array.isArray(res?.messages) ? res.messages : [];
      const ordered = [...arr].reverse();
      setMessages(ordered);
      onThreadLoadedRef.current?.(ordered);
    } catch {
      showToast('Failed to load thread', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (open && activeId) void fetchThread(activeId);
  }, [open, activeId, fetchThread]);

  // Incoming reply — auto-switch to that restaurant's thread if it's a
  // different one than what's currently selected, otherwise just
  // refresh the visible thread.
  useEffect(() => {
    if (!lastMessage) return;
    const rid = lastMessage.restaurantId;
    if (!rid) return;
    if (open) {
      if (activeId && rid === activeId) {
        void fetchThread(activeId);
      } else {
        setActiveId(rid);
      }
    }
  }, [lastMessage, open, activeId, fetchThread]);

  const onSend = async () => {
    const body = text.trim();
    if (!body || sending || !activeId) return;
    setSending(true);
    try {
      await sendAdminMessage(activeId, body);
      setText('');
      await fetchThread(activeId);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const restaurantOptions = useMemo(() => {
    return [...restaurants].sort((a, b) => {
      const an = a.name || a.brand_name || a.registered_business_name || '';
      const bn = b.name || b.brand_name || b.registered_business_name || '';
      return an.localeCompare(bn);
    });
  }, [restaurants]);

  return (
    <SlideOverDrawer open={open} onClose={onClose} title="Message Restaurant">
      <div style={{ padding: '.7rem 1rem', borderBottom: '1px solid var(--rim, #e5e7eb)' }}>
        <label style={{ fontSize: '.74rem', color: 'var(--dim,#6b7280)', display: 'block', marginBottom: '.2rem' }}>
          Restaurant
        </label>
        <select
          value={activeId || ''}
          onChange={(e) => setActiveId(e.target.value || null)}
          style={{
            width: '100%',
            padding: '.45rem .55rem',
            fontSize: '.86rem',
            border: '1px solid var(--rim,#e5e7eb)',
            borderRadius: 6,
            background: 'var(--ink,#fff)',
            color: 'var(--fg,inherit)',
          }}
        >
          <option value="">Select a restaurant…</option>
          {restaurantOptions.map((r) => {
            const display = r.name || r.brand_name || r.registered_business_name || r.id;
            return (
              <option key={r.id} value={r.id}>
                {display}
              </option>
            );
          })}
        </select>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '.8rem 1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '.5rem',
        }}
      >
        {!activeId ? (
          <p style={{ color: 'var(--dim,#6b7280)', fontSize: '.85rem' }}>
            Pick a restaurant above to view the thread.
          </p>
        ) : loading && messages.length === 0 ? (
          <p style={{ color: 'var(--dim,#6b7280)', fontSize: '.85rem' }}>Loading…</p>
        ) : messages.length === 0 ? (
          <p style={{ color: 'var(--dim,#6b7280)', fontSize: '.85rem' }}>
            No messages yet. Send the first one below.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.from === 'admin';
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: mine ? 'flex-end' : 'flex-start',
                  maxWidth: '78%',
                  background: mine ? 'var(--brand-50, #ecfdf5)' : 'var(--ink2, #f4f4f5)',
                  border: `1px solid ${mine ? 'var(--brand-300, #6ee7b7)' : 'var(--rim, #e5e7eb)'}`,
                  borderRadius: 10,
                  padding: '.45rem .65rem',
                }}
              >
                <div style={{ fontSize: '.86rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {m.message}
                </div>
                <div style={{ fontSize: '.66rem', color: 'var(--dim,#6b7280)', marginTop: '.25rem' }}>
                  {mine ? 'Admin (you)' : 'Restaurant'} · {fmtTime(m.created_at)}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div
        style={{
          borderTop: '1px solid var(--rim, #e5e7eb)',
          padding: '.6rem .75rem',
          display: 'flex',
          gap: '.4rem',
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
          placeholder={activeId ? 'Type a message…' : 'Pick a restaurant first'}
          rows={2}
          disabled={sending || !activeId}
          style={{
            flex: 1,
            resize: 'none',
            padding: '.5rem .6rem',
            border: '1px solid var(--rim, #e5e7eb)',
            borderRadius: 8,
            fontSize: '.86rem',
            fontFamily: 'inherit',
            background: 'var(--ink, #fff)',
            color: 'var(--fg, inherit)',
          }}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sending || !text.trim() || !activeId}
          style={{
            padding: '.5rem .9rem',
            background:
              sending || !text.trim() || !activeId
                ? 'var(--rim,#e5e7eb)'
                : 'var(--brand-600,#059669)',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor:
              sending || !text.trim() || !activeId ? 'default' : 'pointer',
            fontSize: '.85rem',
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </SlideOverDrawer>
  );
}
