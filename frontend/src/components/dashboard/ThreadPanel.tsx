'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { getThread, replyToThread, resolveThread } from '../../api/restaurant';
import { useToast } from '../Toast';
import type { Thread } from './ConversationList';

// Mirrors loadMsgThread() + refreshActiveThread() + sendMsgReply() + resolveThread()
// in legacy messages.js:97-188.
const THREAD_POLL_MS = 15000;
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface Message {
  id?: string;
  _id?: string;
  direction?: 'inbound' | 'outbound';
  message_type?: string;
  text?: string;
  caption?: string;
  status?: string;
  created_at?: string;
}

interface ThreadResponse {
  messages?: Message[];
}

function formatTime(ts?: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function isWindowOpen(messages: Message[]): boolean {
  const lastInbound = [...(messages || [])].reverse().find((m) => m.direction === 'inbound');
  if (!lastInbound || !lastInbound.created_at) return false;
  return (Date.now() - new Date(lastInbound.created_at).getTime()) < REPLY_WINDOW_MS;
}

function MessageBubble({ message }: { message: Message }) {
  const isInbound = message.direction === 'inbound';
  const type = message.message_type || 'text';
  const bg = isInbound ? 'var(--ink3)' : 'rgba(37,211,102,.15)';
  const border = isInbound ? undefined : '1px solid rgba(37,211,102,.3)';

  let content: React.ReactNode;
  if (type === 'image') {
    content = (
      <>
        <div
          style={{
            width: 200,
            height: 140,
            background: 'var(--ink2)',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '2rem',
            marginBottom: '.3rem',
          }}
        >
          📷
        </div>
        {message.caption && <div>{message.caption}</div>}
      </>
    );
  } else if (type === 'document') {
    content = (
      <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
        <span style={{ fontSize: '1.1rem' }}>📎</span>
        <span>{message.caption || 'Document'}</span>
      </div>
    );
  } else if (type === 'location') {
    content = '📍 Location shared';
  } else if (type === 'sticker') {
    content = '🏷️ Sticker';
  } else {
    content = message.text || '';
  }

  return (
    <div
      style={{
        alignSelf: isInbound ? 'flex-start' : 'flex-end',
        maxWidth: '75%',
        padding: '.5rem .7rem',
        borderRadius: 12,
        background: bg,
        border,
        fontSize: '.83rem',
        lineHeight: 1.45,
      }}
    >
      <div>{content}</div>
      <div
        style={{
          fontSize: '.62rem',
          color: 'var(--dim)',
          textAlign: 'right',
          marginTop: '.2rem',
        }}
      >
        {formatTime(message.created_at)}
        {!isInbound && ` · ${message.status || 'sent'}`}
      </div>
    </div>
  );
}

interface ThreadPanelProps {
  customerId?: string | null;
  conversation?: Thread | undefined;
  onResolved?: () => void;
  onThreadChanged?: () => void;
}

interface FetchOpts { silent?: boolean }

export default function ThreadPanel({ customerId, conversation, onResolved, onThreadChanged }: ThreadPanelProps) {
  const { showToast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [replyText, setReplyText] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const [resolving, setResolving] = useState<boolean>(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const fetchThread = useCallback(
    async (opts: FetchOpts = {}) => {
      if (!customerId) return;
      const { silent = false } = opts;
      if (!silent) setLoading(true);
      try {
        const r = (await getThread(customerId)) as ThreadResponse | null | undefined;
        const msgs = r?.messages || [];
        setMessages(msgs);
        if (!silent) {
          queueMicrotask(() => {
            if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
          });
        } else if (bodyRef.current) {
          const b = bodyRef.current;
          const wasAtBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
          if (wasAtBottom) queueMicrotask(() => { b.scrollTop = b.scrollHeight; });
        }
      } catch (e: unknown) {
        const err = e as { message?: string };
        if (!silent) showToast(err?.message || 'Failed to load thread', 'error');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [customerId, showToast],
  );

  useEffect(() => {
    setMessages([]);
    setReplyText('');
    if (!customerId) return;
    fetchThread();
    const id = setInterval(() => fetchThread({ silent: true }), THREAD_POLL_MS);
    return () => clearInterval(id);
  }, [customerId, fetchThread]);

  const windowOpen = isWindowOpen(messages);
  const status = conversation?.status;
  const showResolve = status !== 'resolved';
  const displayName = conversation?.customer_name || conversation?.customer_phone || 'Customer';
  const displayPhone = conversation?.customer_phone || '';

  const handleSend = async (e: FormEvent<HTMLFormElement>) => {
    e?.preventDefault?.();
    const text = replyText.trim();
    if (!text || sending || !customerId) return;
    setSending(true);
    try {
      await replyToThread(customerId, { text });
      setReplyText('');
      await fetchThread({ silent: true });
      onThreadChanged?.();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e2?.response?.data?.error || e2?.message || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleResolve = async () => {
    if (resolving || !customerId) return;
    setResolving(true);
    try {
      await resolveThread(customerId);
      showToast('Thread resolved', 'success');
      onResolved?.();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e2?.response?.data?.error || e2?.message || 'Resolve failed', 'error');
    } finally {
      setResolving(false);
    }
  };

  if (!customerId) {
    return (
      <div
        style={{
          textAlign: 'center',
          color: 'var(--dim)',
          padding: '3rem 0',
          fontSize: '.85rem',
        }}
      >
        Select a conversation to view messages
      </div>
    );
  }

  return (
    <>
      <div
        id="msg-thread-header"
        style={{ padding: '.7rem 1rem', borderBottom: '1px solid var(--rim)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '.7rem' }}>
          <div style={{ flex: 1 }}>
            <div id="msg-thread-name" style={{ fontWeight: 600, fontSize: '.9rem' }}>
              {displayName}
            </div>
            <div id="msg-thread-info" style={{ fontSize: '.72rem', color: 'var(--dim)' }}>
              {displayPhone}
            </div>
          </div>
          {showResolve && (
            <button
              type="button"
              id="msg-resolve-btn"
              className="btn-g btn-sm"
              onClick={handleResolve}
              disabled={resolving}
            >
              {resolving ? '…' : '✅ Resolve'}
            </button>
          )}
        </div>
        {!windowOpen && (
          <div
            id="msg-window-warning"
            style={{
              marginTop: '.4rem',
              padding: '.3rem .6rem',
              background: '#fef3c7',
              borderRadius: 6,
              fontSize: '.72rem',
              color: '#92400e',
            }}
          >
            ⚠️ 24-hour reply window has expired. Use template messages to contact this customer.
          </div>
        )}
      </div>
      <div
        id="msg-thread-body"
        ref={bodyRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '.4rem',
        }}
      >
        {loading ? (
          <div className="spin" style={{ margin: '2rem auto', display: 'block', width: 22, height: 22 }} />
        ) : messages.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              color: 'var(--dim)',
              padding: '2rem 0',
              fontSize: '.82rem',
            }}
          >
            No messages in this thread
          </div>
        ) : (
          messages.map((m, idx) => <MessageBubble key={m.id || m._id || idx} message={m} />)
        )}
      </div>
      <form
        id="msg-reply-bar"
        onSubmit={handleSend}
        style={{ display: 'flex', padding: '.6rem', borderTop: '1px solid var(--rim)', gap: '.4rem' }}
      >
        <input
          id="msg-reply-input"
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder={windowOpen ? 'Type a reply…' : '24h window expired'}
          disabled={!windowOpen || sending}
          style={{
            flex: 1,
            padding: '.5rem .7rem',
            border: '1px solid var(--rim)',
            borderRadius: 8,
            fontSize: '.85rem',
          }}
        />
        <button
          type="submit"
          className="btn-p btn-sm"
          disabled={!windowOpen || sending || !replyText.trim()}
        >
          {sending ? '…' : 'Send'}
        </button>
      </form>
    </>
  );
}
