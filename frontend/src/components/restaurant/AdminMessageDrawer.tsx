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
        {loading && messages.length === 0 ? (
          <p style={{ color: 'var(--dim,#6b7280)', fontSize: '.85rem' }}>Loading…</p>
        ) : messages.length === 0 ? (
          <p style={{ color: 'var(--dim,#6b7280)', fontSize: '.85rem' }}>
            No messages yet. The GullyBite team will reach out here when needed — and you can
            reply at any time.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.from === 'restaurant';
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
                  {mine ? 'You' : 'GullyBite'} · {fmtTime(m.created_at)}
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
          disabled={sending || !text.trim()}
          style={{
            padding: '.5rem .9rem',
            background: sending || !text.trim() ? 'var(--rim,#e5e7eb)' : 'var(--brand-600,#059669)',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor: sending || !text.trim() ? 'default' : 'pointer',
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
