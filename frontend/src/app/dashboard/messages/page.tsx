'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ConversationList, { type Thread } from '../../../components/restaurant/ConversationList';
import ThreadPanel from '../../../components/restaurant/ThreadPanel';
import IssueList, { type IssueListItem } from '../../../components/restaurant/IssueList';
import IssueDetailPanel from '../../../components/restaurant/IssueDetailPanel';
import { getMessages, getIssues, getUnreadCount } from '../../../api/restaurant';
import { useToast } from '../../../components/Toast';

// Legacy splits Messages and Issues into two top-level tabs
// (dashboard.html:746, 786). The Phase 2f spec unifies them under
// /dashboard/messages with a sub-tab toggle — we honor the spec.

const MSG_FILTERS: ReadonlyArray<readonly [string, string]> = [
  ['all', 'All'],
  ['unread', 'Unread'],
  ['active_orders', 'Active Orders'],
  ['resolved', 'Resolved'],
];

const ISS_FILTERS: ReadonlyArray<readonly [string, string]> = [
  ['open_all', 'Open'],
  ['in_progress', 'In Progress'],
  ['escalated', 'Escalated'],
  ['resolved', 'Resolved'],
  ['', 'All'],
];

const UNREAD_POLL_MS = 30000;
const MSG_SEARCH_DEBOUNCE = 350;
const ISS_SEARCH_DEBOUNCE = 400;

type ActiveView = 'messages' | 'issues';

interface MessagesResponse { threads?: Thread[] }
interface IssuesResponse { issues?: IssueListItem[] }
interface UnreadResponse { count?: number }

export default function MessagesPage() {
  const { showToast } = useToast();
  const [activeView, setActiveView] = useState<ActiveView>('messages');

  const [conversations, setConversations] = useState<Thread[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [msgLoading, setMsgLoading] = useState<boolean>(false);
  const [msgFilter, setMsgFilter] = useState<string>('all');
  const [msgSearchInput, setMsgSearchInput] = useState<string>('');
  const [msgSearch, setMsgSearch] = useState<string>('');

  const [issues, setIssues] = useState<IssueListItem[]>([]);
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [issLoading, setIssLoading] = useState<boolean>(false);
  const [issFilter, setIssFilter] = useState<string>('open_all');
  const [issSearchInput, setIssSearchInput] = useState<string>('');
  const [issSearch, setIssSearch] = useState<string>('');

  const [unreadCount, setUnreadCount] = useState<number>(0);
  const msgSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const issSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchConversations = useCallback(async () => {
    setMsgLoading(true);
    try {
      const params: Record<string, string> = {};
      if (msgFilter && msgFilter !== 'all') params.status = msgFilter;
      if (msgSearch) params.search = msgSearch;
      const r = (await getMessages(params)) as MessagesResponse | null | undefined;
      setConversations(Array.isArray(r?.threads) ? r.threads : []);
    } catch (e: unknown) {
      const err = e as { message?: string };
      showToast(err?.message || 'Failed to load conversations', 'error');
      setConversations([]);
    } finally {
      setMsgLoading(false);
    }
  }, [msgFilter, msgSearch, showToast]);

  const fetchIssues = useCallback(async () => {
    setIssLoading(true);
    try {
      const params: Record<string, string | number> = { page: 1, limit: 20 };
      if (issFilter) params.status = issFilter;
      if (issSearch) params.search = issSearch;
      const r = (await getIssues(params)) as IssuesResponse | null | undefined;
      setIssues(Array.isArray(r?.issues) ? r.issues : []);
    } catch (e: unknown) {
      const err = e as { message?: string };
      showToast(err?.message || 'Failed to load issues', 'error');
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
        const r = (await getUnreadCount()) as UnreadResponse | null | undefined;
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

  const onMsgSearchChange = (v: string) => {
    setMsgSearchInput(v);
    if (msgSearchTimerRef.current) clearTimeout(msgSearchTimerRef.current);
    msgSearchTimerRef.current = setTimeout(() => setMsgSearch(v.trim()), MSG_SEARCH_DEBOUNCE);
  };

  const onIssSearchChange = (v: string) => {
    setIssSearchInput(v);
    if (issSearchTimerRef.current) clearTimeout(issSearchTimerRef.current);
    issSearchTimerRef.current = setTimeout(() => setIssSearch(v.trim()), ISS_SEARCH_DEBOUNCE);
  };

  useEffect(() => () => {
    if (msgSearchTimerRef.current) clearTimeout(msgSearchTimerRef.current);
    if (issSearchTimerRef.current) clearTimeout(issSearchTimerRef.current);
  }, []);

  const switchView = (view: ActiveView) => {
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
      <div className="flex gap-2 mb-[0.8rem] items-center">
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

      <div className="flex gap-4 h-[calc(100vh-180px)] min-h-[500px]">
        <div className="w-[340px] shrink-0 flex flex-col bg-ink2 rounded-r border border-rim overflow-hidden">
          {activeView === 'messages' ? (
            <>
              <div className="p-[0.7rem] border-b border-rim">
                <input
                  id="msg-search"
                  placeholder="Search messages…"
                  value={msgSearchInput}
                  onChange={(e) => onMsgSearchChange(e.target.value)}
                  className="w-full py-[0.4rem] px-[0.6rem] border border-rim rounded-lg text-[0.82rem]"
                />
                <div className="flex gap-[0.3rem] mt-2 flex-wrap">
                  {MSG_FILTERS.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={msgFilter === value ? 'btn-p btn-sm' : 'btn-g btn-sm'}
                      aria-pressed={msgFilter === value}
                      onClick={() => setMsgFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div
                id="msg-thread-list"
                className="flex-1 overflow-y-auto p-[0.4rem]"
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
              <div className="p-[0.7rem] border-b border-rim">
                <input
                  id="iss-search"
                  placeholder="Search issues…"
                  value={issSearchInput}
                  onChange={(e) => onIssSearchChange(e.target.value)}
                  className="w-full py-[0.4rem] px-[0.6rem] border border-rim rounded-lg text-[0.82rem]"
                />
                <div className="flex gap-[0.3rem] mt-2 flex-wrap">
                  {ISS_FILTERS.map(([value, label]) => (
                    <button
                      key={value || 'all'}
                      type="button"
                      className={issFilter === value ? 'btn-p btn-sm' : 'btn-g btn-sm'}
                      aria-pressed={issFilter === value}
                      onClick={() => setIssFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-[0.4rem]">
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

        <div className="flex-1 flex flex-col bg-ink2 rounded-r border border-rim overflow-hidden">
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
