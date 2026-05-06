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
      <div className="py-[0.7rem] px-4 border-b border-rim">
        <label className="text-[0.74rem] text-dim block mb-[0.2rem]">
          Restaurant
        </label>
        <select
          value={activeId || ''}
          onChange={(e) => setActiveId(e.target.value || null)}
          className="w-full py-[0.45rem] px-[0.55rem] text-[0.86rem] border border-rim rounded-md bg-ink text-fg"
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
      <div className="flex-1 min-h-0 overflow-y-auto py-[0.8rem] px-4 flex flex-col gap-2">
        {!activeId ? (
          <p className="text-dim text-[0.85rem]">
            Pick a restaurant above to view the thread.
          </p>
        ) : loading && messages.length === 0 ? (
          <p className="text-dim text-[0.85rem]">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-dim text-[0.85rem]">
            No messages yet. Send the first one below.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.from === 'admin';
            return (
              <div
                key={m.id}
                className={`max-w-[78%] rounded-[10px] py-[0.45rem] px-[0.65rem] border ${
                  mine
                    ? 'self-end bg-brand-50 border-brand-300'
                    : 'self-start bg-ink2 border-rim'
                }`}
              >
                <div className="text-[0.86rem] whitespace-pre-wrap break-words">
                  {m.message}
                </div>
                <div className="text-[0.66rem] text-dim mt-1">
                  {mine ? 'Admin (you)' : 'Restaurant'} · {fmtTime(m.created_at)}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="border-t border-rim py-[0.6rem] px-3 flex gap-[0.4rem]">
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
          className="flex-1 resize-none py-2 px-[0.6rem] border border-rim rounded-lg text-[0.86rem] font-[inherit] bg-ink text-fg"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sending || !text.trim() || !activeId}
          className={`py-2 px-[0.9rem] text-white border-0 rounded-lg text-[0.85rem] font-semibold whitespace-nowrap ${
            sending || !text.trim() || !activeId
              ? 'bg-rim cursor-default'
              : 'bg-brand-600 cursor-pointer'
          }`}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </SlideOverDrawer>
  );
}
