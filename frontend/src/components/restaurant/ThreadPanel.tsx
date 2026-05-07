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
  const bubbleBg = isInbound ? 'bg-ink3' : 'bg-[rgba(37,211,102,0.15)]';
  const bubbleBorder = isInbound ? '' : 'border border-[rgba(37,211,102,0.3)]';
  const align = isInbound ? 'self-start' : 'self-end';

  let content: React.ReactNode;
  if (type === 'image') {
    content = (
      <>
        <div className="w-[200px] h-[140px] bg-ink2 rounded-lg flex items-center justify-center text-[2rem] mb-[0.3rem]">
          📷
        </div>
        {message.caption && <div>{message.caption}</div>}
      </>
    );
  } else if (type === 'document') {
    content = (
      <div className="flex items-center gap-[0.4rem]">
        <span className="text-[1.1rem]">📎</span>
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
      className={`max-w-[75%] py-2 px-[0.7rem] rounded-xl text-[0.83rem] leading-[1.45] ${align} ${bubbleBg} ${bubbleBorder}`}
    >
      <div>{content}</div>
      <div className="text-[0.62rem] text-dim text-right mt-[0.2rem]">
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
      <div className="text-center text-dim py-12 text-[0.85rem]">
        Select a conversation to view messages
      </div>
    );
  }

  return (
    <>
      <div
        id="msg-thread-header"
        className="py-[0.7rem] px-4 border-b border-rim"
      >
        <div className="flex items-center gap-[0.7rem]">
          <div className="flex-1">
            <div id="msg-thread-name" className="font-semibold text-[0.9rem]">
              {displayName}
            </div>
            <div id="msg-thread-info" className="text-[0.72rem] text-dim">
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
            className="mt-[0.4rem] py-[0.3rem] px-[0.6rem] bg-[#fef3c7] rounded-md text-[0.72rem] text-[#92400e]"
          >
            ⚠️ 24-hour reply window has expired. Use template messages to contact this customer.
          </div>
        )}
      </div>
      <div
        id="msg-thread-body"
        ref={bodyRef}
        className="flex-1 overflow-y-auto p-4 flex flex-col gap-[0.4rem]"
      >
        {loading ? (
          <div className="spin my-8 mx-auto block w-[22px] h-[22px]" />
        ) : messages.length === 0 ? (
          <div className="text-center text-dim py-8 text-[0.82rem]">
            No messages in this thread
          </div>
        ) : (
          messages.map((m, idx) => <MessageBubble key={m.id || m._id || idx} message={m} />)
        )}
      </div>
      <form
        id="msg-reply-bar"
        onSubmit={handleSend}
        className="flex p-[0.6rem] border-t border-rim gap-[0.4rem]"
      >
        <input
          id="msg-reply-input"
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder={windowOpen ? 'Type a reply…' : '24h window expired'}
          disabled={!windowOpen || sending}
          className="flex-1 py-2 px-[0.7rem] border border-rim rounded-lg text-[0.85rem]"
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
