'use client';

// Restaurant-side drawer for the admin↔restaurant DM thread. Shows
// the merchant's running conversation with the platform admin and
// lets them reply. Mounted in DashboardLayoutClient's navbar `actions`
// slot — open via a "Messages from GullyBite" button with an unread
// badge that clears when the drawer is opened (server marks rows
// read=true on the GET).
//
// Auto-open: when SocketProvider's `lastMessage` reference changes
// (a new admin → restaurant message arrived), the drawer opens
// itself. Spec'd that way so merchants can't miss a platform message.

import { useCallback, useEffect, useRef, useState } from 'react';
import SlideOverDrawer from '../shared/SlideOverDrawer';
import { useSocketContext } from '../shared/SocketProvider';
import { useToast } from '../Toast';
import { getAdminMessages, replyAdminMessage } from '../../api/restaurant';
import type { AdminRestaurantMessage } from '../../types';

function fmtTime(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

interface AdminMessageDrawerProps {
  open: boolean;
  onClose: () => void;
  // Called whenever the local thread state changes — used by the
  // mount point in the navbar to recompute the unread badge.
  onThreadLoaded?: (messages: AdminRestaurantMessage[]) => void;
}

export default function AdminMessageDrawer({ open, onClose, onThreadLoaded }: AdminMessageDrawerProps) {
  const { showToast } = useToast();
  const { lastMessage } = useSocketContext();
  const [messages, setMessages] = useState<AdminRestaurantMessage[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [text, setText] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const onThreadLoadedRef = useRef(onThreadLoaded);
  onThreadLoadedRef.current = onThreadLoaded;

  const fetchThread = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAdminMessages();
      const arr = Array.isArray(res?.messages) ? res.messages : [];
      // Backend returns newest-first; flip for chronological display.
      const ordered = [...arr].reverse();
      setMessages(ordered);
      onThreadLoadedRef.current?.(ordered);
    } catch {
      showToast('Failed to load messages', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  // Refetch when the drawer opens (also clears unread server-side via
  // the GET endpoint's mark-as-read side effect).
  useEffect(() => {
    if (open) void fetchThread();
  }, [open, fetchThread]);

  // Auto-refetch on incoming socket events. Cheaper than pushing the
  // single payload onto the array because we'd have to dedupe against
  // a possible echo from the GET. The thread is bounded to 50 rows so
  // re-pulling is fine.
  useEffect(() => {
    if (!lastMessage) return;
    if (open) void fetchThread();
  }, [lastMessage, open, fetchThread]);

  const onSend = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await replyAdminMessage(body);
      setText('');
      await fetchThread();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <SlideOverDrawer open={open} onClose={onClose} title="Messages from GullyBite">
      <div className="flex-1 min-h-0 overflow-y-auto py-[0.8rem] px-4 flex flex-col gap-2">
        {loading && messages.length === 0 ? (
          <p className="text-dim text-[0.85rem]">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-dim text-[0.85rem]">
            No messages yet. The GullyBite team will reach out here when needed — and you can
            reply at any time.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.from === 'restaurant';
            return (
              <div
                key={m.id}
                className={`max-w-[78%] rounded-[10px] py-[0.45rem] px-[0.65rem] border ${
                  mine
                    ? 'self-end bg-brand-50 border-brand-300'
                    : 'self-start bg-ink2 border-rim'
                }`}
              >
                <div className="text-[0.86rem] whitespace-pre-wrap wrap-break-word">
                  {m.message}
                </div>
                <div className="text-[0.66rem] text-dim mt-1">
                  {mine ? 'You' : 'GullyBite'} · {fmtTime(m.created_at)}
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
            // Enter sends, Shift+Enter inserts a newline — same as most
            // chat UIs. The button is the explicit fallback for users
            // who'd rather click.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
          placeholder="Type a reply…"
          rows={2}
          disabled={sending}
          className="flex-1 resize-none py-2 px-[0.6rem] border border-rim rounded-lg text-[0.86rem] font-[inherit] bg-ink text-fg"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sending || !text.trim()}
          className={`py-2 px-[0.9rem] text-white border-0 rounded-lg text-[0.85rem] font-semibold whitespace-nowrap ${
            sending || !text.trim()
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
