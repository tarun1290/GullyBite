import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
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
} from '../../api/admin.js';

// Mirrors admin.html loadAdmIssueList + openAdmIssDetail (4067-4300).

const PAGE_LIMIT = 30;

const PRI_CLR = { critical: '#dc2626', high: '#f59e0b', medium: '#3b82f6', low: '#94a3b8' };
const ST_CLR = {
  open: '#3b82f6', assigned: '#8b5cf6', in_progress: '#f59e0b', waiting_customer: '#6366f1',
  escalated_to_admin: '#dc2626', resolved: '#16a34a', closed: '#64748b', reopened: '#ef4444',
};
const CAT_LABEL = {
  food_quality: '🍕 Food', missing_item: '📦 Missing', wrong_order: '❌ Wrong',
  delivery_late: '🕐 Late', delivery_not_received: '🚫 Not Recv', delivery_damaged: '💥 Damaged',
  rider_behavior: '🛵 Rider', wrong_charge: '💸 Charge', refund_request: '💰 Refund',
  payment_failed: '⚠️ Payment', coupon_issue: '🏷️ Coupon', general: '💬 General',
  app_issue: '📱 App', portion_size: '📏 Portion', packaging: '📦 Pkg', hygiene: '🧹 Hygiene',
  wrong_address: '📍 Addr',
};

const TABS = [
  { key: 'admin_queue', label: 'Admin Queue' },
  { key: 'open_all',    label: 'All Open' },
  { key: 'escalated',   label: 'Escalated' },
  { key: 'sla_breached',label: 'SLA Breached' },
  { key: 'resolved',    label: 'Resolved' },
  { key: '',            label: 'All' },
];

const CATEGORIES = [
  ['', 'All Categories'],
  ['food_quality', 'Food Quality'], ['missing_item', 'Missing Item'],
  ['wrong_order', 'Wrong Order'], ['delivery_late', 'Late Delivery'],
  ['delivery_not_received', 'Not Received'], ['delivery_damaged', 'Damaged'],
  ['wrong_charge', 'Wrong Charge'], ['refund_request', 'Refund'],
  ['payment_failed', 'Payment Failed'], ['general', 'General'],
];

const PRIORITIES = [
  ['', 'All Priorities'], ['critical', 'Critical'], ['high', 'High'],
  ['medium', 'Medium'], ['low', 'Low'],
];

function slaLabel(issue) {
  if (['resolved', 'closed'].includes(issue.status)) return <span style={{ color: '#16a34a' }}>✓</span>;
  if (!issue.sla_deadline) return '—';
  const rem = new Date(issue.sla_deadline).getTime() - Date.now();
  if (rem <= 0) return <span style={{ color: '#dc2626', fontWeight: 600 }}>🔴 Breached</span>;
  const h = Math.floor(rem / 3600000);
  const m = Math.floor((rem % 3600000) / 60000);
  if (rem < 3600000) return <span style={{ color: '#dc2626' }}>🟡 {m}m</span>;
  if (h < 6) return <span style={{ color: '#f59e0b' }}>🟡 {h}h{m}m</span>;
  return <span style={{ color: '#16a34a' }}>🟢 {h}h</span>;
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid var(--rim)', borderRadius: 10,
      padding: '.65rem .8rem', boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ fontSize: '.65rem', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, color }}>{value || 0}</div>
    </div>
  );
}

export default function AdminIssues() {
  const { showToast } = useToast();
  const [tab, setTab] = useState('admin_queue');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState('');
  const [pendingSearch, setPendingSearch] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [stats, setStats] = useState(null);
  const [statsErr, setStatsErr] = useState(null);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const [activeId, setActiveId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reply, setReply] = useState('');
  const [replyInternal, setReplyInternal] = useState(false);
  const [replyBusy, setReplyBusy] = useState(false);

  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveType, setResolveType] = useState('refund_full');
  const [resolveNotes, setResolveNotes] = useState('');
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagFrom, setFlagFrom] = useState('restaurant');
  const [flagAmount, setFlagAmount] = useState('');

  const searchTimer = useRef(null);
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
      const s = await getAdminIssueStats({ admin_queue: 'true' });
      setStats(s || null);
    } catch (e) {
      setStatsErr(e?.response?.data?.error || e?.message || 'Failed to load stats');
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const params = { page, limit: PAGE_LIMIT };
    if (tab === 'admin_queue') params.admin_queue = 'true';
    else if (tab) params.status = tab;
    if (category) params.category = category;
    if (priority) params.priority = priority;
    if (search) params.search = search;
    try {
      const r = await getAdminIssues(params);
      setData(r || null);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || 'Failed to load issues');
    } finally {
      setLoading(false);
    }
  }, [tab, category, priority, search, page]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadList(); }, [loadList]);

  const openDetail = async (id) => {
    setActiveId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = await getAdminIssue(id);
      setDetail(d || null);
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Failed to load issue', 'error');
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
    const d = await getAdminIssue(activeId);
    setDetail(d || null);
  };

  const doStatus = async (status) => {
    if (!activeId) return;
    try {
      if (status === 'reopened') await reopenAdminIssue(activeId);
      else await setAdminIssueStatus(activeId, status);
      showToast('Updated', 'success');
      await refreshDetail();
      await loadList();
      await loadStats();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Update failed', 'error');
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
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Send failed', 'error');
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
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Resolve failed', 'error');
    }
  };

  const doRefund = async () => {
    if (!activeId) return;
    try {
      const r = await refundAdminIssue(activeId, refundAmount || undefined);
      const amt = r?.issue?.refund_amount_rs || refundAmount;
      showToast(`Refund of ₹${amt} processed`, 'success');
      setRefundOpen(false);
      setRefundAmount('');
      await refreshDetail();
      await loadList();
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Refund failed', 'error');
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
    } catch (e) {
      showToast(e?.response?.data?.error || e?.message || 'Flag failed', 'error');
    }
  };

  const issues = data?.issues || [];
  const pages = data?.pages || 1;
  const curPage = data?.page || page;

  return (
    <div id="pg-issues">
      {statsErr ? (
        <div style={{ marginBottom: '.8rem' }}>
          <SectionError message={statsErr} onRetry={loadStats} />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '.65rem', marginBottom: '1rem' }}>
          <StatCard label="Open" value={stats?.open} color="#3b82f6" />
          <StatCard label="In Progress" value={stats?.in_progress} color="#f59e0b" />
          <StatCard label="Escalated" value={stats?.escalated} color="#dc2626" />
          <StatCard label="SLA Breached" value={stats?.sla_breached} color={stats?.sla_breached > 0 ? '#dc2626' : '#94a3b8'} />
          <StatCard label="Resolved" value={stats?.resolved} color="#16a34a" />
          <StatCard label="Total" value={stats?.total} color="var(--acc)" />
        </div>
      )}

      <div style={{ display: 'flex', gap: '.4rem', marginBottom: '.7rem', flexWrap: 'wrap', alignItems: 'center' }}>
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
          style={{ ...sel, marginLeft: 'auto' }}
        >
          {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); }} style={sel}>
          {PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input
          placeholder="Search…"
          value={pendingSearch}
          onChange={(e) => setPendingSearch(e.target.value)}
          style={{ ...sel, width: 180 }}
        />
      </div>

      <div className="card">
        {err ? (
          <div className="cb"><SectionError message={err} onRetry={loadList} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', borderBottom: '1px solid var(--rim)' }}>
                  <th style={th}>Issue #</th>
                  <th style={th}>Restaurant</th>
                  <th style={th}>Category</th>
                  <th style={th}>Customer</th>
                  <th style={th}>Order</th>
                  <th style={th}>Priority</th>
                  <th style={th}>Status</th>
                  <th style={th}>Routed To</th>
                  <th style={th}>SLA</th>
                  <th style={th}>Age</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={11} style={emptyCell}>Loading…</td></tr>
                ) : issues.length === 0 ? (
                  <tr><td colSpan={11} style={emptyCell}>No issues</td></tr>
                ) : (
                  issues.map((i) => {
                    const priClr = PRI_CLR[i.priority] || '#94a3b8';
                    const stClr = ST_CLR[i.status] || '#64748b';
                    return (
                      <tr
                        key={i._id}
                        style={{ borderBottom: '1px solid var(--rim)', cursor: 'pointer' }}
                        onClick={() => openDetail(i._id)}
                      >
                        <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>{i.issue_number}</td>
                        <td style={{ ...td, fontSize: '.78rem' }}>
                          {i.restaurant_id ? String(i.restaurant_id).slice(-6) : '—'}
                        </td>
                        <td style={{ ...td, fontSize: '.78rem' }}>{CAT_LABEL[i.category] || i.category}</td>
                        <td style={{ ...td, fontSize: '.8rem' }}>{i.customer_name || '—'}</td>
                        <td style={{ ...td, fontSize: '.76rem', color: 'var(--dim)' }}>{i.order_number || '—'}</td>
                        <td style={td}>
                          <span style={{ color: priClr, fontWeight: 600, fontSize: '.72rem', textTransform: 'uppercase' }}>
                            {i.priority}
                          </span>
                        </td>
                        <td style={td}>
                          <span style={{ background: stClr, color: '#fff', fontSize: '.68rem', padding: '.1rem .35rem', borderRadius: 4, fontWeight: 600 }}>
                            {String(i.status).replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td style={{ ...td, fontSize: '.72rem', color: 'var(--dim)' }}>{i.routed_to || '—'}</td>
                        <td style={{ ...td, fontSize: '.72rem' }}>{slaLabel(i)}</td>
                        <td style={{ ...td, fontSize: '.72rem', color: 'var(--dim)' }}>{timeAgo(i.created_at)}</td>
                        <td style={td}>
                          <button
                            type="button"
                            className="btn-g btn-sm"
                            style={{ fontSize: '.7rem', padding: '.12rem .35rem' }}
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
          <div style={{ display: 'flex', justifyContent: 'center', gap: '.4rem', padding: '.7rem' }}>
            {curPage > 1 && (
              <button type="button" className="btn-g btn-sm" onClick={() => setPage(curPage - 1)}>« Prev</button>
            )}
            <span style={{ fontSize: '.78rem', color: 'var(--dim)', padding: '.3rem .5rem' }}>
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
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)',
            zIndex: 999, overflowY: 'auto',
          }}
          onClick={closeDetail}
        >
          <div
            style={{
              margin: '1.5rem auto', maxWidth: 850, background: '#fff',
              borderRadius: 12, boxShadow: 'var(--shadow)', overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {detailLoading || !detail ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>Loading…</div>
            ) : (
              <>
                <div style={{ padding: '1rem 1.2rem', borderBottom: '1px solid var(--rim)', display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: '.95rem' }}>{detail.issue_number}</span>
                  <span style={{ fontSize: '.78rem', padding: '.12rem .5rem', borderRadius: 6, background: 'var(--ink)' }}>
                    {CAT_LABEL[detail.category] || detail.category}
                  </span>
                  <span style={{
                    fontSize: '.72rem', fontWeight: 700, padding: '.12rem .4rem', borderRadius: 4,
                    color: PRI_CLR[detail.priority] || '#94a3b8', textTransform: 'uppercase',
                  }}>{detail.priority}</span>
                  <span style={{
                    fontSize: '.72rem', fontWeight: 600, padding: '.12rem .4rem', borderRadius: 4,
                    color: '#fff', background: ST_CLR[detail.status] || '#64748b',
                  }}>{String(detail.status).replace(/_/g, ' ')}</span>
                  <span style={{ fontSize: '.72rem', marginLeft: 'auto' }}>{slaLabel(detail)}</span>
                  <button type="button" className="btn-g btn-sm" onClick={closeDetail}>Close</button>
                </div>

                <div style={{ padding: '.7rem 1.2rem', borderBottom: '1px solid var(--rim)', display: 'flex', gap: '1.5rem', fontSize: '.82rem', flexWrap: 'wrap' }}>
                  <div><span style={{ color: 'var(--dim)' }}>Customer:</span> <strong>{detail.customer_name || 'Unknown'}</strong></div>
                  <div><span style={{ color: 'var(--dim)' }}>Phone:</span> {detail.customer_phone || '—'}</div>
                  <div><span style={{ color: 'var(--dim)' }}>Order:</span> {detail.order_number || '—'}</div>
                  <div><span style={{ color: 'var(--dim)' }}>Restaurant:</span> {detail.restaurant_id || '—'}</div>
                  <div><span style={{ color: 'var(--dim)' }}>Routed:</span> {detail.routed_to || '—'}</div>
                </div>

                {(detail._payment || detail._delivery || detail._order) && (
                  <div style={{ padding: '.6rem 1.2rem', borderBottom: '1px solid var(--rim)', fontSize: '.8rem', background: 'var(--ink4)' }}>
                    {detail._payment && (
                      <span style={{ marginRight: '1rem' }}>
                        💳 Razorpay: <strong>{detail._payment.rp_payment_id}</strong>
                        {' · '}₹{detail._payment.amount_rs}
                        {detail._payment.method ? ` · ${detail._payment.method}` : ''}
                      </span>
                    )}
                    {detail._delivery && (
                      <span style={{ marginRight: '1rem' }}>
                        🛵 {detail._delivery.provider}: {detail._delivery.provider_order_id || '—'}
                        {' · '}{detail._delivery.status}
                        {detail._delivery.tracking_url && (
                          <> · <a href={detail._delivery.tracking_url} target="_blank" rel="noreferrer" style={{ color: 'var(--acc)' }}>Track</a></>
                        )}
                      </span>
                    )}
                    {detail._order && (
                      <span>📦 Order: {detail._order.status} · ₹{detail._order.total_rs}</span>
                    )}
                  </div>
                )}

                <div style={{ padding: '.7rem 1.2rem', borderBottom: '1px solid var(--rim)' }}>
                  <div style={{ fontSize: '.7rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 600, marginBottom: '.25rem' }}>Description</div>
                  <div style={{ fontSize: '.85rem', lineHeight: 1.5 }}>{detail.description || ''}</div>
                </div>

                <div style={{ padding: '.7rem 1.2rem', borderBottom: '1px solid var(--rim)' }}>
                  <div style={{ fontSize: '.7rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 600, marginBottom: '.4rem' }}>Thread</div>
                  <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
                    {(detail.messages || []).map((m, i) => {
                      if (m.sender_type === 'system') {
                        return (
                          <div key={i} style={{ textAlign: 'center', fontSize: '.72rem', color: 'var(--dim)', padding: '.15rem 0' }}>
                            {m.text}
                          </div>
                        );
                      }
                      const isCust = m.sender_type === 'customer';
                      const align = isCust ? 'flex-start' : 'flex-end';
                      const bg = isCust ? 'var(--ink)' : m.internal ? 'rgba(79,70,229,.08)' : 'rgba(22,163,74,.08)';
                      const border = m.internal ? '1px dashed rgba(79,70,229,.25)' : '1px solid transparent';
                      const when = new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                      return (
                        <div key={i} style={{
                          alignSelf: align, maxWidth: '80%', padding: '.4rem .6rem',
                          borderRadius: 10, background: bg, border,
                          fontSize: '.82rem', lineHeight: 1.4,
                        }}>
                          <div style={{ fontSize: '.65rem', fontWeight: 600, color: 'var(--dim)', marginBottom: '.1rem' }}>
                            {m.sender_name}{m.internal ? ' (internal)' : ''}
                          </div>
                          <div>{m.text}</div>
                          <div style={{ fontSize: '.6rem', color: 'var(--dim)', textAlign: 'right', marginTop: '.1rem' }}>
                            {when}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: '.5rem', display: 'flex', gap: '.4rem', alignItems: 'center' }}>
                    <input
                      placeholder="Reply…"
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') doSend(); }}
                      style={{ flex: 1, padding: '.4rem .6rem', border: '1px solid var(--rim)', borderRadius: 7, fontSize: '.82rem' }}
                      disabled={replyBusy}
                    />
                    <label style={{ fontSize: '.72rem', display: 'flex', alignItems: 'center', gap: '.2rem', color: 'var(--dim)', whiteSpace: 'nowrap' }}>
                      <input type="checkbox" checked={replyInternal} onChange={(e) => setReplyInternal(e.target.checked)} />
                      Internal
                    </label>
                    <button type="button" className="btn-p btn-sm" onClick={doSend} disabled={replyBusy || !reply.trim()}>
                      Send
                    </button>
                  </div>
                </div>

                <div style={{ padding: '.7rem 1.2rem', display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
                  {['open', 'escalated_to_admin', 'reopened'].includes(detail.status) && (
                    <button type="button" className="btn-p btn-sm" onClick={() => doStatus('in_progress')}>
                      Start Working
                    </button>
                  )}
                  {!['resolved', 'closed'].includes(detail.status) && (
                    <>
                      <button
                        type="button"
                        className="btn-g btn-sm"
                        style={{ color: '#16a34a', borderColor: '#16a34a' }}
                        onClick={() => setResolveOpen(true)}
                      >Resolve</button>
                      {detail.order_id && detail._payment && (
                        <button
                          type="button"
                          className="btn-g btn-sm"
                          style={{ color: '#dc2626', borderColor: '#dc2626' }}
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
                      className="btn-g btn-sm"
                      style={{ textDecoration: 'none' }}
                    >🛵 Track Delivery</a>
                  )}
                </div>

                {resolveOpen && (
                  <div style={inlineForm}>
                    <div style={{ fontWeight: 600, marginBottom: '.4rem' }}>Resolve issue</div>
                    <label style={lbl}>Resolution type</label>
                    <select value={resolveType} onChange={(e) => setResolveType(e.target.value)} style={{ ...sel, width: '100%' }}>
                      <option value="refund_full">Refund (full)</option>
                      <option value="refund_partial">Refund (partial)</option>
                      <option value="credit">Credit</option>
                      <option value="replacement">Replacement</option>
                      <option value="redelivery">Re-delivery</option>
                      <option value="apology">Apology</option>
                      <option value="explanation">Explanation</option>
                      <option value="no_action">No action</option>
                    </select>
                    <label style={{ ...lbl, marginTop: '.5rem' }}>Notes (optional)</label>
                    <textarea
                      rows={2}
                      value={resolveNotes}
                      onChange={(e) => setResolveNotes(e.target.value)}
                      style={{ width: '100%', padding: '.4rem .6rem', border: '1px solid var(--rim)', borderRadius: 6, fontFamily: 'inherit', fontSize: '.82rem', resize: 'vertical' }}
                    />
                    <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginTop: '.5rem' }}>
                      <button type="button" className="btn-g btn-sm" onClick={() => setResolveOpen(false)}>Cancel</button>
                      <button type="button" className="btn-p btn-sm" onClick={doResolve}>Resolve</button>
                    </div>
                  </div>
                )}

                {refundOpen && (
                  <div style={inlineForm}>
                    <div style={{ fontWeight: 600, marginBottom: '.4rem' }}>Issue refund</div>
                    <label style={lbl}>Refund amount (₹) — leave blank for full order</label>
                    <input
                      type="number"
                      min="0"
                      value={refundAmount}
                      onChange={(e) => setRefundAmount(e.target.value)}
                      style={{ width: '100%', padding: '.4rem .6rem', border: '1px solid var(--rim)', borderRadius: 6, fontSize: '.82rem' }}
                    />
                    <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginTop: '.5rem' }}>
                      <button type="button" className="btn-g btn-sm" onClick={() => setRefundOpen(false)}>Cancel</button>
                      <button
                        type="button"
                        className="btn-sm"
                        style={{ background: '#dc2626', color: '#fff' }}
                        onClick={doRefund}
                      >Refund</button>
                    </div>
                  </div>
                )}

                {flagOpen && (
                  <div style={inlineForm}>
                    <div style={{ fontWeight: 600, marginBottom: '.4rem' }}>Flag for settlement</div>
                    <label style={lbl}>Deduct from</label>
                    <select value={flagFrom} onChange={(e) => setFlagFrom(e.target.value)} style={{ ...sel, width: '100%' }}>
                      <option value="restaurant">Restaurant</option>
                      <option value="platform">Platform</option>
                      <option value="3pl">3PL</option>
                    </select>
                    <label style={{ ...lbl, marginTop: '.5rem' }}>Amount (₹)</label>
                    <input
                      type="number"
                      min="0"
                      value={flagAmount}
                      onChange={(e) => setFlagAmount(e.target.value)}
                      style={{ width: '100%', padding: '.4rem .6rem', border: '1px solid var(--rim)', borderRadius: 6, fontSize: '.82rem' }}
                    />
                    <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginTop: '.5rem' }}>
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

const th = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td = { padding: '.6rem .7rem', verticalAlign: 'top' };
const emptyCell = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const sel = { background: '#fff', border: '1px solid var(--rim)', borderRadius: 6, padding: '.3rem .55rem', fontSize: '.78rem' };
const lbl = { fontSize: '.72rem', color: 'var(--dim)', display: 'block', marginBottom: '.2rem' };
const inlineForm = { padding: '.8rem 1.2rem', borderTop: '1px solid var(--rim)', background: 'var(--ink3)' };
