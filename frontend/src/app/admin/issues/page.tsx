'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  flagIssueSettlement,
  getAdminIssue,
  getAdminIssueStats,
  getAdminIssues,
  postAdminIssueMessage,
  refundAdminIssue,
  reopenAdminIssue,
  resolveAdminIssue,
  setAdminIssueStatus,
} from '../../../api/admin';

const PAGE_LIMIT = 30;

const PRI_CLR: Record<string, string> = { critical: 'var(--gb-red-500)', high: '#f59e0b', medium: '#3b82f6', low: 'var(--gb-slate-400)' };
const ST_CLR: Record<string, string> = {
  open: '#3b82f6', assigned: '#8b5cf6', in_progress: '#f59e0b', waiting_customer: 'var(--gb-indigo-500)',
  escalated_to_admin: 'var(--gb-red-500)', resolved: 'var(--gb-wa-500)', closed: 'var(--gb-slate-500)', reopened: '#ef4444',
};
const CAT_LABEL: Record<string, string> = {
  food_quality: '🍕 Food', missing_item: '📦 Missing', wrong_order: '❌ Wrong',
  delivery_late: '🕐 Late', delivery_not_received: '🚫 Not Recv', delivery_damaged: '💥 Damaged',
  rider_behavior: '🛵 Rider', wrong_charge: '💸 Charge', refund_request: '💰 Refund',
  payment_failed: '⚠️ Payment', coupon_issue: '🏷️ Coupon', general: '💬 General',
  app_issue: '📱 App', portion_size: '📏 Portion', packaging: '📦 Pkg', hygiene: '🧹 Hygiene',
  wrong_address: '📍 Addr',
};

const TABS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'admin_queue', label: 'Admin Queue' },
  { key: 'open_all',    label: 'All Open' },
  { key: 'escalated',   label: 'Escalated' },
  { key: 'sla_breached',label: 'SLA Breached' },
  { key: 'resolved',    label: 'Resolved' },
  { key: '',            label: 'All' },
];

const CATEGORIES: ReadonlyArray<readonly [string, string]> = [
  ['', 'All Categories'],
  ['food_quality', 'Food Quality'], ['missing_item', 'Missing Item'],
  ['wrong_order', 'Wrong Order'], ['delivery_late', 'Late Delivery'],
  ['delivery_not_received', 'Not Received'], ['delivery_damaged', 'Damaged'],
  ['wrong_charge', 'Wrong Charge'], ['refund_request', 'Refund'],
  ['payment_failed', 'Payment Failed'], ['general', 'General'],
];

const PRIORITIES: ReadonlyArray<readonly [string, string]> = [
  ['', 'All Priorities'], ['critical', 'Critical'], ['high', 'High'],
  ['medium', 'Medium'], ['low', 'Low'],
];

interface AdminIssue {
  _id: string;
  issue_number?: string;
  restaurant_id?: string;
  category?: string;
  customer_name?: string;
  customer_phone?: string;
  order_number?: string;
  order_id?: string;
  display_order_id?: string;
  priority?: string;
  status?: string;
  routed_to?: string;
  sla_deadline?: string;
  created_at?: string;
}

interface IssueMessage {
  sender_type?: string;
  sender_name?: string;
  internal?: boolean;
  text?: string;
  created_at?: string;
}

interface PaymentInfo {
  rp_payment_id?: string;
  amount_rs?: number;
  method?: string;
}

interface DeliveryInfo {
  provider?: string;
  provider_order_id?: string;
  status?: string;
  tracking_url?: string;
}

interface OrderInfo {
  status?: string;
  total_rs?: number;
}

interface AdminIssueDetail extends AdminIssue {
  description?: string;
  messages?: IssueMessage[];
  approval_status?: string;
  _payment?: PaymentInfo;
  _delivery?: DeliveryInfo;
  _order?: OrderInfo;
}

interface IssuesListResponse {
  issues?: AdminIssue[];
  pages?: number;
  page?: number;
}

interface IssueStats {
  open?: number;
  in_progress?: number;
  escalated?: number;
  sla_breached?: number;
  resolved?: number;
  total?: number;
}

interface RefundResp { issue?: { refund_amount_rs?: number | string } }

function slaLabel(issue: AdminIssue): ReactNode {
  if (['resolved', 'closed'].includes(issue.status || '')) return <span className="text-wa-500">✓</span>;
  if (!issue.sla_deadline) return '—';
  const rem = new Date(issue.sla_deadline).getTime() - Date.now();
  if (rem <= 0) return <span className="text-red-500 font-semibold">🔴 Breached</span>;
  const h = Math.floor(rem / 3600000);
  const m = Math.floor((rem % 3600000) / 60000);
  if (rem < 3600000) return <span className="text-red-500">🟡 {m}m</span>;
  if (h < 6) return <span className="text-[#f59e0b]">🟡 {h}h{m}m</span>;
  return <span className="text-wa-500">🟢 {h}h</span>;
}

function timeAgo(ts?: string): string {
  if (!ts) return '';
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

interface StatCardProps { label: string; value?: number | string; color?: string }

function StatCard({ label, value, color }: StatCardProps): ReactNode {
  return (
    <div className="bg-neutral-0 border border-rim rounded-[10px] py-[0.65rem] px-[0.8rem] shadow-sm-token">
      <div className="text-[0.65rem] text-dim uppercase tracking-[0.04em] font-semibold">
        {label}
      </div>
      {/* color is dynamic — passed in from caller based on stat type */}
      <div className="text-[1.4rem] font-bold" style={{ color }}>{value || 0}</div>
    </div>
  );
}

const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.6rem] px-[0.7rem] align-top';
const EMPTY_CELL_CLS = 'p-6 text-center text-dim';
const SEL_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.3rem] px-[0.55rem] text-[0.78rem]';
const LBL_CLS = 'text-[0.72rem] text-dim block mb-[0.2rem]';
const INLINE_FORM_CLS = 'py-[0.8rem] px-[1.2rem] border-t border-rim bg-ink3';

export default function AdminIssuesPage() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<string>('admin_queue');
  const [category, setCategory] = useState<string>('');
  const [priority, setPriority] = useState<string>('');
  const [pendingSearch, setPendingSearch] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [page, setPage] = useState<number>(1);

  const [stats, setStats] = useState<IssueStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);

  const [data, setData] = useState<IssuesListResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminIssueDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [reply, setReply] = useState<string>('');
  const [replyInternal, setReplyInternal] = useState<boolean>(false);
  const [replyBusy, setReplyBusy] = useState<boolean>(false);

  const [resolveOpen, setResolveOpen] = useState<boolean>(false);
  const [resolveType, setResolveType] = useState<string>('refund_full');
  const [resolveNotes, setResolveNotes] = useState<string>('');
  const [refundOpen, setRefundOpen] = useState<boolean>(false);
  const [refundAmount, setRefundAmount] = useState<string>('');
  const [flagOpen, setFlagOpen] = useState<boolean>(false);
  const [flagFrom, setFlagFrom] = useState<string>('restaurant');
  const [flagAmount, setFlagAmount] = useState<string>('');

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearch(pendingSearch);
      setPage(1);
    }, 400);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [pendingSearch]);

  const loadStats = useCallback(async () => {
    setStatsErr(null);
    try {
      const s = (await getAdminIssueStats({ admin_queue: 'true' })) as IssueStats | null;
      setStats(s || null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setStatsErr(er?.response?.data?.error || er?.message || 'Failed to load stats');
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const params: Record<string, string | number> = { page, limit: PAGE_LIMIT };
    if (tab === 'admin_queue') params.admin_queue = 'true';
    else if (tab) params.status = tab;
    if (category) params.category = category;
    if (priority) params.priority = priority;
    if (search) params.search = search;
    try {
      const r = (await getAdminIssues(params)) as IssuesListResponse | null;
      setData(r || null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed to load issues');
    } finally {
      setLoading(false);
    }
  }, [tab, category, priority, search, page]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadList(); }, [loadList]);

  const openDetail = async (id: string) => {
    setActiveId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = (await getAdminIssue(id)) as AdminIssueDetail | null;
      setDetail(d || null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to load issue', 'error');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setActiveId(null);
    setDetail(null);
    setResolveOpen(false);
    setRefundOpen(false);
    setFlagOpen(false);
  };

  const refreshDetail = async () => {
    if (!activeId) return;
    const d = (await getAdminIssue(activeId)) as AdminIssueDetail | null;
    setDetail(d || null);
  };

  const doStatus = async (status: string) => {
    if (!activeId) return;
    try {
      if (status === 'reopened') await reopenAdminIssue(activeId);
      else await setAdminIssueStatus(activeId, status);
      showToast('Updated', 'success');
      await refreshDetail();
      await loadList();
      await loadStats();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Update failed', 'error');
    }
  };

  const doSend = async () => {
    if (!reply.trim() || !activeId) return;
    setReplyBusy(true);
    try {
      await postAdminIssueMessage(activeId, { text: reply.trim(), internal: replyInternal });
      setReply('');
      setReplyInternal(false);
      await refreshDetail();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Send failed', 'error');
    } finally {
      setReplyBusy(false);
    }
  };

  const doResolve = async () => {
    if (!activeId || !resolveType) return;
    try {
      await resolveAdminIssue(activeId, {
        resolution_type: resolveType,
        resolution_notes: resolveNotes.trim(),
      });
      showToast('Resolved', 'success');
      setResolveOpen(false);
      setResolveNotes('');
      await refreshDetail();
      await loadList();
      await loadStats();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Resolve failed', 'error');
    }
  };

  const doRefund = async () => {
    if (!activeId) return;
    try {
      const amt = refundAmount ? Number(refundAmount) : undefined;
      const r = (await refundAdminIssue(activeId, amt)) as RefundResp | null;
      const display = r?.issue?.refund_amount_rs || refundAmount;
      showToast(`Refund of ₹${display} processed`, 'success');
      setRefundOpen(false);
      setRefundAmount('');
      await refreshDetail();
      await loadList();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Refund failed', 'error');
    }
  };

  const doFlag = async () => {
    if (!activeId || !flagAmount) return;
    try {
      await flagIssueSettlement(activeId, { deduct_from: flagFrom, amount_rs: flagAmount });
      showToast('Flagged for settlement', 'success');
      setFlagOpen(false);
      setFlagAmount('');
      await refreshDetail();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Flag failed', 'error');
    }
  };

  const issues: AdminIssue[] = data?.issues || [];
  const pages = data?.pages || 1;
  const curPage = data?.page || page;

  return (
    <div id="pg-issues">
      {statsErr ? (
        <div className="mb-[0.8rem]">
          <SectionError message={statsErr} onRetry={loadStats} />
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-[0.65rem] mb-4">
          <StatCard label="Open" value={stats?.open} color="#3b82f6" />
          <StatCard label="In Progress" value={stats?.in_progress} color="#f59e0b" />
          <StatCard label="Escalated" value={stats?.escalated} color="var(--gb-red-500)" />
          <StatCard label="SLA Breached" value={stats?.sla_breached} color={(stats?.sla_breached || 0) > 0 ? 'var(--gb-red-500)' : 'var(--gb-slate-400)'} />
          <StatCard label="Resolved" value={stats?.resolved} color="var(--gb-wa-500)" />
          <StatCard label="Total" value={stats?.total} color="var(--acc)" />
        </div>
      )}

      <div className="flex gap-[0.4rem] mb-[0.7rem] flex-wrap items-center">
        {TABS.map((t) => (
          <button
            key={t.key || 'all'}
            type="button"
            className={tab === t.key ? 'btn-p btn-sm' : 'btn-g btn-sm'}
            onClick={() => { setTab(t.key); setPage(1); }}
          >{t.label}</button>
        ))}
        <select
          value={category}
          onChange={(e) => { setCategory(e.target.value); setPage(1); }}
          className={`${SEL_CLS} ml-auto`}
        >
          {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); }} className={SEL_CLS}>
          {PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input
          placeholder="Search…"
          value={pendingSearch}
          onChange={(e) => setPendingSearch(e.target.value)}
          className={`${SEL_CLS} w-[180px]`}
        />
      </div>

      <div className="card">
        {err ? (
          <div className="cb"><SectionError message={err} onRetry={loadList} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={TH_CLS}>Issue #</th>
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Category</th>
                  <th className={TH_CLS}>Customer</th>
                  <th className={TH_CLS}>Order</th>
                  <th className={TH_CLS}>Priority</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Routed To</th>
                  <th className={TH_CLS}>SLA</th>
                  <th className={TH_CLS}>Age</th>
                  <th className={TH_CLS}></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={11} className={EMPTY_CELL_CLS}>Loading…</td></tr>
                ) : issues.length === 0 ? (
                  <tr><td colSpan={11} className={EMPTY_CELL_CLS}>No issues</td></tr>
                ) : (
                  issues.map((i) => {
                    const priClr = PRI_CLR[i.priority || ''] || 'var(--gb-slate-400)';
                    const stClr = ST_CLR[i.status || ''] || 'var(--gb-slate-500)';
                    return (
                      <tr
                        key={i._id}
                        className="border-b border-rim cursor-pointer"
                        onClick={() => openDetail(i._id)}
                      >
                        <td className={`${TD_CLS} font-semibold whitespace-nowrap`}>{i.issue_number}</td>
                        <td className={`${TD_CLS} text-[0.78rem]`}>
                          {i.restaurant_id ? String(i.restaurant_id).slice(-6) : '—'}
                        </td>
                        <td className={`${TD_CLS} text-[0.78rem]`}>{CAT_LABEL[i.category || ''] || i.category}</td>
                        <td className={`${TD_CLS} text-[0.8rem]`}>{i.customer_name || '—'}</td>
                        <td className={`${TD_CLS} text-[0.76rem] text-dim`}>
                          {i.display_order_id ? (
                            <>
                              <div>{i.display_order_id}</div>
                              {i.order_number && (
                                <div className="text-[0.66rem] text-mute">
                                  {i.order_number}
                                </div>
                              )}
                            </>
                          ) : (
                            <>{i.order_number || '—'}</>
                          )}
                        </td>
                        <td className={TD_CLS}>
                          {/* color from PRI_CLR palette by priority key at runtime */}
                          <span className="font-semibold text-[0.72rem] uppercase" style={{ color: priClr }}>
                            {i.priority}
                          </span>
                        </td>
                        <td className={TD_CLS}>
                          {/* background from ST_CLR palette by status key at runtime */}
                          <span className="text-neutral-0 text-[0.68rem] py-[0.1rem] px-[0.35rem] rounded-xs font-semibold" style={{ background: stClr }}>
                            {String(i.status).replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className={`${TD_CLS} text-[0.72rem] text-dim`}>{i.routed_to || '—'}</td>
                        <td className={`${TD_CLS} text-[0.72rem]`}>{slaLabel(i)}</td>
                        <td className={`${TD_CLS} text-[0.72rem] text-dim`}>{timeAgo(i.created_at)}</td>
                        <td className={TD_CLS}>
                          <button
                            type="button"
                            className="btn-g btn-sm text-[0.7rem] py-[0.12rem] px-[0.35rem]"
                            onClick={(e) => { e.stopPropagation(); openDetail(i._id); }}
                          >View</button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="flex justify-center gap-[0.4rem] p-[0.7rem]">
            {curPage > 1 && (
              <button type="button" className="btn-g btn-sm" onClick={() => setPage(curPage - 1)}>« Prev</button>
            )}
            <span className="text-[0.78rem] text-dim py-[0.3rem] px-2">
              Page {curPage} of {pages}
            </span>
            {curPage < pages && (
              <button type="button" className="btn-g btn-sm" onClick={() => setPage(curPage + 1)}>Next »</button>
            )}
          </div>
        )}
      </div>

      {activeId && (
        <div
          className="fixed inset-0 bg-black/40 z-999 overflow-y-auto"
          onClick={closeDetail}
        >
          <div
            className="my-6 mx-auto max-w-[850px] bg-neutral-0 rounded-xl shadow-default overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {detailLoading || !detail ? (
              <div className="p-8 text-center text-dim">Loading…</div>
            ) : (
              <>
                <div className="py-4 px-[1.2rem] border-b border-rim flex items-center gap-[0.6rem] flex-wrap">
                  <span className="font-bold text-[0.95rem]">{detail.issue_number}</span>
                  <span className="text-[0.78rem] py-[0.12rem] px-2 rounded-md bg-ink">
                    {CAT_LABEL[detail.category || ''] || detail.category}
                  </span>
                  {/* color from PRI_CLR palette by priority key at runtime */}
                  <span
                    className="text-[0.72rem] font-bold py-[0.12rem] px-[0.4rem] rounded-xs uppercase"
                    style={{ color: PRI_CLR[detail.priority || ''] || 'var(--gb-slate-400)' }}
                  >{detail.priority}</span>
                  {/* background from ST_CLR palette by status key at runtime */}
                  <span
                    className="text-[0.72rem] font-semibold py-[0.12rem] px-[0.4rem] rounded-xs text-neutral-0"
                    style={{ background: ST_CLR[detail.status || ''] || 'var(--gb-slate-500)' }}
                  >{String(detail.status).replace(/_/g, ' ')}</span>
                  <span className="text-[0.72rem] ml-auto">{slaLabel(detail)}</span>
                  <button type="button" className="btn-g btn-sm" onClick={closeDetail}>Close</button>
                </div>

                <div className="py-[0.7rem] px-[1.2rem] border-b border-rim flex gap-6 text-[0.82rem] flex-wrap">
                  <div><span className="text-dim">Customer:</span> <strong>{detail.customer_name || 'Unknown'}</strong></div>
                  <div><span className="text-dim">Phone:</span> {detail.customer_phone || '—'}</div>
                  <div>
                    <span className="text-dim">Order:</span>{' '}
                    {detail.display_order_id ? (
                      <>
                        <strong>{detail.display_order_id}</strong>
                        {detail.order_number && (
                          <span className="text-[0.7rem] text-mute ml-[0.4rem]">
                            ({detail.order_number})
                          </span>
                        )}
                      </>
                    ) : (
                      detail.order_number || '—'
                    )}
                  </div>
                  <div><span className="text-dim">Restaurant:</span> {detail.restaurant_id || '—'}</div>
                  <div><span className="text-dim">Routed:</span> {detail.routed_to || '—'}</div>
                </div>

                {(detail._payment || detail._delivery || detail._order) && (
                  <div className="py-[0.6rem] px-[1.2rem] border-b border-rim text-[0.8rem] bg-ink4">
                    {detail._payment && (
                      <span className="mr-4">
                        💳 Razorpay: <strong>{detail._payment.rp_payment_id}</strong>
                        {' · '}₹{detail._payment.amount_rs}
                        {detail._payment.method ? ` · ${detail._payment.method}` : ''}
                      </span>
                    )}
                    {detail._delivery && (
                      <span className="mr-4">
                        🛵 {detail._delivery.provider}: {detail._delivery.provider_order_id || '—'}
                        {' · '}{detail._delivery.status}
                        {detail._delivery.tracking_url && (
                          <> · <a href={detail._delivery.tracking_url} target="_blank" rel="noreferrer" className="text-acc">Track</a></>
                        )}
                      </span>
                    )}
                    {detail._order && (
                      <span>📦 Order: {detail._order.status} · ₹{detail._order.total_rs}</span>
                    )}
                  </div>
                )}

                <div className="py-[0.7rem] px-[1.2rem] border-b border-rim">
                  <div className="text-[0.7rem] text-dim uppercase font-semibold mb-1">Description</div>
                  <div className="text-[0.85rem] leading-normal">{detail.description || ''}</div>
                </div>

                <div className="py-[0.7rem] px-[1.2rem] border-b border-rim">
                  <div className="text-[0.7rem] text-dim uppercase font-semibold mb-[0.4rem]">Thread</div>
                  <div className="max-h-[280px] overflow-y-auto flex flex-col gap-[0.3rem]">
                    {(detail.messages || []).map((m, i) => {
                      if (m.sender_type === 'system') {
                        return (
                          <div key={i} className="text-center text-[0.72rem] text-dim py-[0.15rem]">
                            {m.text}
                          </div>
                        );
                      }
                      const isCust = m.sender_type === 'customer';
                      const align = isCust ? 'flex-start' : 'flex-end';
                      const bg = isCust ? 'var(--ink)' : m.internal ? 'rgba(79,70,229,.08)' : 'rgba(22,163,74,.08)';
                      const border = m.internal ? '1px dashed rgba(79,70,229,.25)' : '1px solid transparent';
                      const when = m.created_at ? new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                      return (
                        // alignSelf, background, border are dynamic per-message based on sender_type/internal
                        <div key={i} style={{ alignSelf: align, background: bg, border }} className="max-w-[80%] py-[0.4rem] px-[0.6rem] rounded-[10px] text-[0.82rem] leading-[1.4]">
                          <div className="text-[0.65rem] font-semibold text-dim mb-[0.1rem]">
                            {m.sender_name}{m.internal ? ' (internal)' : ''}
                          </div>
                          <div>{m.text}</div>
                          <div className="text-[0.6rem] text-dim text-right mt-[0.1rem]">
                            {when}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex gap-[0.4rem] items-center">
                    <input
                      placeholder="Reply…"
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') doSend(); }}
                      className="flex-1 py-[0.4rem] px-[0.6rem] border border-rim rounded-[7px] text-[0.82rem]"
                      disabled={replyBusy}
                    />
                    <label className="text-[0.72rem] flex items-center gap-[0.2rem] text-dim whitespace-nowrap">
                      <input type="checkbox" checked={replyInternal} onChange={(e) => setReplyInternal(e.target.checked)} />
                      Internal
                    </label>
                    <button type="button" className="btn-p btn-sm" onClick={doSend} disabled={replyBusy || !reply.trim()}>
                      Send
                    </button>
                  </div>
                </div>

                <div className="py-[0.7rem] px-[1.2rem] flex gap-[0.4rem] flex-wrap">
                  {['open', 'escalated_to_admin', 'reopened'].includes(detail.status || '') && (
                    <button type="button" className="btn-p btn-sm" onClick={() => doStatus('in_progress')}>
                      Start Working
                    </button>
                  )}
                  {!['resolved', 'closed'].includes(detail.status || '') && (
                    <>
                      <button
                        type="button"
                        className="btn-g btn-sm text-wa-500 border-wa-500"
                        onClick={() => setResolveOpen(true)}
                      >Resolve</button>
                      {detail.order_id && detail._payment && (
                        <button
                          type="button"
                          className="btn-g btn-sm text-red-500 border-red-500"
                          onClick={() => setRefundOpen(true)}
                        >💰 Issue Refund</button>
                      )}
                      <button type="button" className="btn-g btn-sm" onClick={() => setFlagOpen(true)}>
                        🏷️ Flag for Settlement
                      </button>
                    </>
                  )}
                  {detail.status === 'resolved' && (
                    <button type="button" className="btn-g btn-sm" onClick={() => doStatus('reopened')}>Reopen</button>
                  )}
                  {detail._delivery?.tracking_url && (
                    <a
                      href={detail._delivery.tracking_url}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-g btn-sm no-underline"
                    >🛵 Track Delivery</a>
                  )}
                </div>

                {resolveOpen && (
                  <div className={INLINE_FORM_CLS}>
                    <div className="font-semibold mb-[0.4rem]">Resolve issue</div>
                    <label className={LBL_CLS}>Resolution type</label>
                    <select value={resolveType} onChange={(e) => setResolveType(e.target.value)} className={`${SEL_CLS} w-full`}>
                      <option value="refund_full">Refund (full)</option>
                      <option value="refund_partial">Refund (partial)</option>
                      <option value="credit">Credit</option>
                      <option value="replacement">Replacement</option>
                      <option value="redelivery">Re-delivery</option>
                      <option value="apology">Apology</option>
                      <option value="explanation">Explanation</option>
                      <option value="no_action">No action</option>
                    </select>
                    <label className={`${LBL_CLS} mt-2`}>Notes (optional)</label>
                    <textarea
                      rows={2}
                      value={resolveNotes}
                      onChange={(e) => setResolveNotes(e.target.value)}
                      className="w-full py-[0.4rem] px-[0.6rem] border border-rim rounded-md font-[inherit] text-[0.82rem] resize-y"
                    />
                    <div className="flex gap-2 justify-end mt-2">
                      <button type="button" className="btn-g btn-sm" onClick={() => setResolveOpen(false)}>Cancel</button>
                      <button type="button" className="btn-p btn-sm" onClick={doResolve}>Resolve</button>
                    </div>
                  </div>
                )}

                {refundOpen && (
                  <div className={INLINE_FORM_CLS}>
                    <div className="font-semibold mb-[0.4rem]">Issue refund</div>
                    <label className={LBL_CLS}>Refund amount (₹) — leave blank for full order</label>
                    <input
                      type="number"
                      min="0"
                      value={refundAmount}
                      onChange={(e) => setRefundAmount(e.target.value)}
                      className="w-full py-[0.4rem] px-[0.6rem] border border-rim rounded-md text-[0.82rem]"
                    />
                    <div className="flex gap-2 justify-end mt-2">
                      <button type="button" className="btn-g btn-sm" onClick={() => setRefundOpen(false)}>Cancel</button>
                      <button
                        type="button"
                        className="btn-del btn-sm"
                        onClick={doRefund}
                      >Refund</button>
                    </div>
                  </div>
                )}

                {flagOpen && (
                  <div className={INLINE_FORM_CLS}>
                    <div className="font-semibold mb-[0.4rem]">Flag for settlement</div>
                    <label className={LBL_CLS}>Deduct from</label>
                    <select value={flagFrom} onChange={(e) => setFlagFrom(e.target.value)} className={`${SEL_CLS} w-full`}>
                      <option value="restaurant">Restaurant</option>
                      <option value="platform">Platform</option>
                      <option value="3pl">3PL</option>
                    </select>
                    <label className={`${LBL_CLS} mt-2`}>Amount (₹)</label>
                    <input
                      type="number"
                      min="0"
                      value={flagAmount}
                      onChange={(e) => setFlagAmount(e.target.value)}
                      className="w-full py-[0.4rem] px-[0.6rem] border border-rim rounded-md text-[0.82rem]"
                    />
                    <div className="flex gap-2 justify-end mt-2">
                      <button type="button" className="btn-g btn-sm" onClick={() => setFlagOpen(false)}>Cancel</button>
                      <button type="button" className="btn-p btn-sm" onClick={doFlag} disabled={!flagAmount}>Flag</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
