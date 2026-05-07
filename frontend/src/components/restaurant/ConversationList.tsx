'use client';

// Renders left-pane thread list for MessagesTab. Mirrors fetchThreads() DOM in
// legacy messages.js:29-43 — name, preview (60-char truncate), timeAgo, unread
// pill, "Active Order" pill, and active-selection border/background.

export interface Thread {
  customer_id: string;
  customer_name?: string;
  customer_phone?: string;
  last_message_text?: string;
  last_message_type?: string;
  last_message_at?: string;
  unread_count?: number;
  has_active_order?: boolean;
  status?: string;
}

function timeAgo(ts?: string): string {
  if (!ts) return '';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.max(0, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function previewText(t: Thread): string {
  let lastMsg = t.last_message_text || '';
  if (!lastMsg && t.last_message_type && t.last_message_type !== 'text') {
    lastMsg = `📎 ${t.last_message_type}`;
  }
  return lastMsg.length > 60 ? `${lastMsg.slice(0, 60)}…` : lastMsg;
}

interface ConversationRowProps {
  thread: Thread;
  active: boolean;
  onSelect?: ((customerId: string) => void) | undefined;
}

function ConversationRow({ thread, active, onSelect }: ConversationRowProps) {
  const unread = thread.unread_count || 0;
  const name = thread.customer_name || thread.customer_phone || 'Unknown';
  return (
    <div
      onClick={() => onSelect?.(thread.customer_id)}
      className={`py-[0.6rem] px-[0.7rem] rounded-lg cursor-pointer border transition-all duration-150 ${
        active ? 'border-wa bg-[rgba(37,211,102,0.08)]' : 'border-transparent bg-transparent'
      }`}
    >
      <div className="flex justify-between items-center">
        <span className={`text-[0.84rem] ${unread ? 'font-bold' : 'font-medium'}`}>{name}</span>
        <span className="text-[0.68rem] text-dim">{timeAgo(thread.last_message_at)}</span>
      </div>
      <div className="text-[0.76rem] text-dim mt-[0.15rem] truncate">
        {previewText(thread)}
      </div>
      {unread > 0 && (
        <span className="inline-block mt-1 bg-wa text-white text-[0.6rem] py-[0.1rem] px-[0.4rem] rounded-full font-semibold">
          {unread} new
        </span>
      )}
      {thread.has_active_order && (
        <span className="inline-block mt-1 ml-[0.3rem] text-[0.6rem] py-[0.1rem] px-[0.4rem] rounded-full bg-gold text-black font-semibold">
          Active Order
        </span>
      )}
    </div>
  );
}

interface ConversationListProps {
  conversations: Thread[];
  selectedId?: string | null;
  onSelect?: (customerId: string) => void;
  loading?: boolean;
}

export default function ConversationList({ conversations, selectedId, onSelect, loading }: ConversationListProps) {
  if (loading) {
    return (
      <div className="text-center py-8 px-2">
        <div className="spin mx-auto" />
      </div>
    );
  }
  if (!conversations || conversations.length === 0) {
    return (
      <div className="text-center text-dim py-8 px-2 text-[0.82rem]">
        No conversations found
      </div>
    );
  }
  return (
    <>
      {conversations.map((t) => (
        <ConversationRow
          key={t.customer_id}
          thread={t}
          active={selectedId === t.customer_id}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
