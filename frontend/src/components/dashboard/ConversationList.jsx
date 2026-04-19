// Renders left-pane thread list for MessagesTab. Mirrors fetchThreads() DOM in
// legacy messages.js:29-43 — name, preview (60-char truncate), timeAgo, unread
// pill, "Active Order" pill, and active-selection border/background.

function timeAgo(ts) {
  if (!ts) return '';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.max(0, Math.floor(diff))}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function previewText(t) {
  let lastMsg = t.last_message_text || '';
  if (!lastMsg && t.last_message_type && t.last_message_type !== 'text') {
    lastMsg = `📎 ${t.last_message_type}`;
  }
  return lastMsg.length > 60 ? `${lastMsg.slice(0, 60)}…` : lastMsg;
}

function ConversationRow({ thread, active, onSelect }) {
  const unread = thread.unread_count || 0;
  const name = thread.customer_name || thread.customer_phone || 'Unknown';
  const style = {
    padding: '.6rem .7rem',
    borderRadius: 8,
    cursor: 'pointer',
    border: `1px solid ${active ? 'var(--wa)' : 'transparent'}`,
    background: active ? 'rgba(37,211,102,.08)' : 'transparent',
    transition: 'all .15s',
  };
  return (
    <div
      onClick={() => onSelect?.(thread.customer_id)}
      style={style}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: unread ? 700 : 500, fontSize: '.84rem' }}>{name}</span>
        <span style={{ fontSize: '.68rem', color: 'var(--dim)' }}>{timeAgo(thread.last_message_at)}</span>
      </div>
      <div
        style={{
          fontSize: '.76rem',
          color: 'var(--dim)',
          marginTop: '.15rem',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {previewText(thread)}
      </div>
      {unread > 0 && (
        <span
          style={{
            display: 'inline-block',
            marginTop: '.25rem',
            background: 'var(--wa)',
            color: '#fff',
            fontSize: '.6rem',
            padding: '.1rem .4rem',
            borderRadius: 9,
            fontWeight: 600,
          }}
        >
          {unread} new
        </span>
      )}
      {thread.has_active_order && (
        <span
          style={{
            display: 'inline-block',
            marginTop: '.25rem',
            marginLeft: '.3rem',
            fontSize: '.6rem',
            padding: '.1rem .4rem',
            borderRadius: 9,
            background: 'var(--gold)',
            color: '#000',
            fontWeight: 600,
          }}
        >
          Active Order
        </span>
      )}
    </div>
  );
}

export default function ConversationList({ conversations, selectedId, onSelect, loading }) {
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem .5rem' }}>
        <div className="spin" style={{ margin: '0 auto' }} />
      </div>
    );
  }
  if (!conversations || conversations.length === 0) {
    return (
      <div
        style={{
          textAlign: 'center',
          color: 'var(--dim)',
          padding: '2rem .5rem',
          fontSize: '.82rem',
        }}
      >
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
