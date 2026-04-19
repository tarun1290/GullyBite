import { useCallback, useEffect, useRef, useState } from 'react';
import ConversationList from '../../components/dashboard/ConversationList.jsx';
import ThreadPanel from '../../components/dashboard/ThreadPanel.jsx';
import IssueList from '../../components/dashboard/IssueList.jsx';
import IssueDetailPanel from '../../components/dashboard/IssueDetailPanel.jsx';
import { getMessages, getIssues, getUnreadCount } from '../../api/restaurant.js';
import { useToast } from '../../components/Toast.jsx';

// Legacy splits Messages and Issues into two top-level tabs
// (dashboard.html:746, 786). The Phase 2f spec unifies them under
// /dashboard/messages with a sub-tab toggle — we honor the spec.

// Filter chips for Messages (legacy .msg-filter-btn at dashboard.html:753-756).
const MSG_FILTERS = [
  ['all', 'All'],
  ['unread', 'Unread'],
  ['active_orders', 'Active Orders'],
  ['resolved', 'Resolved'],
];

// Filter chips for Issues (legacy .iss-filter-btn at dashboard.html:791-795).
const ISS_FILTERS = [
  ['open_all', 'Open'],
  ['in_progress', 'In Progress'],
  ['escalated', 'Escalated'],
  ['resolved', 'Resolved'],
  ['', 'All'],
];

// Legacy polls unread-count every 30s when WS is closed (messages.js:242). We
// don't have WS yet, so always poll. Thread polling (15s) lives inside ThreadPanel.
const UNREAD_POLL_MS = 30000;
const MSG_SEARCH_DEBOUNCE = 350;
const ISS_SEARCH_DEBOUNCE = 400;

export default function MessagesTab() {
  const { showToast } = useToast();
  const [activeView, setActiveView] = useState('messages');

  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgFilter, setMsgFilter] = useState('all');
  const [msgSearchInput, setMsgSearchInput] = useState('');
  const [msgSearch, setMsgSearch] = useState('');

  const [issues, setIssues] = useState([]);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [issLoading, setIssLoading] = useState(false);
  const [issFilter, setIssFilter] = useState('open_all');
  const [issSearchInput, setIssSearchInput] = useState('');
  const [issSearch, setIssSearch] = useState('');

  const [unreadCount, setUnreadCount] = useState(0);
  const msgSearchTimerRef = useRef(null);
  const issSearchTimerRef = useRef(null);

  const fetchConversations = useCallback(async () => {
    setMsgLoading(true);
    try {
      const params = {};
      if (msgFilter && msgFilter !== 'all') params.status = msgFilter;
      if (msgSearch) params.search = msgSearch;
      const r = await getMessages(params);
      setConversations(Array.isArray(r?.threads) ? r.threads : []);
    } catch (e) {
      showToast(e?.message || 'Failed to load conversations', 'error');
      setConversations([]);
    } finally {
      setMsgLoading(false);
    }
  }, [msgFilter, msgSearch, showToast]);

  const fetchIssues = useCallback(async () => {
    setIssLoading(true);
    try {
      const params = { page: 1, limit: 20 };
      if (issFilter) params.status = issFilter;
      if (issSearch) params.search = issSearch;
      const r = await getIssues(params);
      setIssues(Array.isArray(r?.issues) ? r.issues : []);
    } catch (e) {
      showToast(e?.message || 'Failed to load issues', 'error');
      setIssues([]);
    } finally {
      setIssLoading(false);
    }
  }, [issFilter, issSearch, showToast]);

  useEffect(() => {
    if (activeView === 'messages') fetchConversations();
  }, [activeView, fetchConversations]);

  useEffect(() => {
    if (activeView === 'issues') fetchIssues();
  }, [activeView, fetchIssues]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await getUnreadCount();
        if (!cancelled) setUnreadCount(r?.count || 0);
      } catch {
        /* ignore — don't spam toasts for background poll */
      }
    };
    tick();
    const id = setInterval(tick, UNREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const onMsgSearchChange = (v) => {
    setMsgSearchInput(v);
    clearTimeout(msgSearchTimerRef.current);
    msgSearchTimerRef.current = setTimeout(() => setMsgSearch(v.trim()), MSG_SEARCH_DEBOUNCE);
  };

  const onIssSearchChange = (v) => {
    setIssSearchInput(v);
    clearTimeout(issSearchTimerRef.current);
    issSearchTimerRef.current = setTimeout(() => setIssSearch(v.trim()), ISS_SEARCH_DEBOUNCE);
  };

  useEffect(() => () => {
    clearTimeout(msgSearchTimerRef.current);
    clearTimeout(issSearchTimerRef.current);
  }, []);

  const switchView = (view) => {
    if (view === activeView) return;
    setActiveView(view);
    setSelectedConversation(null);
    setSelectedIssue(null);
  };

  const activeConversation = conversations.find(
    (c) => c.customer_id === selectedConversation,
  );

  return (
    <div id="tab-messages">
      <div style={{ display: 'flex', gap: '.5rem', marginBottom: '.8rem', alignItems: 'center' }}>
        <button
          type="button"
          className={activeView === 'messages' ? 'chip on' : 'chip'}
          onClick={() => switchView('messages')}
        >
          💬 Messages{unreadCount > 0 ? ` (${unreadCount})` : ''}
        </button>
        <button
          type="button"
          className={activeView === 'issues' ? 'chip on' : 'chip'}
          onClick={() => switchView('issues')}
        >
          🎫 Issues
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          gap: '1rem',
          height: 'calc(100vh - 180px)',
          minHeight: 500,
        }}
      >
        <div
          style={{
            width: 340,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--ink2)',
            borderRadius: 'var(--r)',
            border: '1px solid var(--rim)',
            overflow: 'hidden',
          }}
        >
          {activeView === 'messages' ? (
            <>
              <div style={{ padding: '.7rem', borderBottom: '1px solid var(--rim)' }}>
                <input
                  id="msg-search"
                  placeholder="Search messages…"
                  value={msgSearchInput}
                  onChange={(e) => onMsgSearchChange(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '.4rem .6rem',
                    border: '1px solid var(--rim)',
                    borderRadius: 8,
                    fontSize: '.82rem',
                  }}
                />
                <div style={{ display: 'flex', gap: '.3rem', marginTop: '.5rem', flexWrap: 'wrap' }}>
                  {MSG_FILTERS.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`btn-sm msg-filter-btn${msgFilter === value ? ' active' : ''}`}
                      onClick={() => setMsgFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div
                id="msg-thread-list"
                style={{ flex: 1, overflowY: 'auto', padding: '.4rem' }}
              >
                <ConversationList
                  conversations={conversations}
                  selectedId={selectedConversation}
                  onSelect={setSelectedConversation}
                  loading={msgLoading}
                />
              </div>
            </>
          ) : (
            <>
              <div style={{ padding: '.7rem', borderBottom: '1px solid var(--rim)' }}>
                <input
                  id="iss-search"
                  placeholder="Search issues…"
                  value={issSearchInput}
                  onChange={(e) => onIssSearchChange(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '.4rem .6rem',
                    border: '1px solid var(--rim)',
                    borderRadius: 8,
                    fontSize: '.82rem',
                  }}
                />
                <div style={{ display: 'flex', gap: '.3rem', marginTop: '.5rem', flexWrap: 'wrap' }}>
                  {ISS_FILTERS.map(([value, label]) => (
                    <button
                      key={value || 'all'}
                      type="button"
                      className={`btn-g btn-sm iss-filter-btn${issFilter === value ? ' active' : ''}`}
                      onClick={() => setIssFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '.4rem' }}>
                <IssueList
                  issues={issues}
                  selectedId={selectedIssue}
                  onSelect={setSelectedIssue}
                  loading={issLoading}
                />
              </div>
            </>
          )}
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--ink2)',
            borderRadius: 'var(--r)',
            border: '1px solid var(--rim)',
            overflow: 'hidden',
          }}
        >
          {activeView === 'messages' ? (
            <ThreadPanel
              customerId={selectedConversation}
              conversation={activeConversation}
              onResolved={() => {
                setSelectedConversation(null);
                fetchConversations();
              }}
              onThreadChanged={fetchConversations}
            />
          ) : (
            <IssueDetailPanel
              issueId={selectedIssue}
              onStatusChange={fetchIssues}
            />
          )}
        </div>
      </div>
    </div>
  );
}
