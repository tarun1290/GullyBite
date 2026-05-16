'use client';

import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import PendingApprovalNotice, { isPendingApproval } from '../../../components/restaurant/PendingApprovalNotice';
import {
  sendDineInFeedback,
  getFeedbackStats,
  getFeedbackEscalations,
  resolveFeedbackEscalation,
  getReviewLinks,
  updateReviewLinks,
  getBranches,
  getRatings,
  getRatingsSummary,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

const PAGE_LIMIT = 20;

interface BySourceBucket {
  avg?: number | string;
  count?: number;
}

interface FeedbackStats {
  average_rating?: number | string;
  total_ratings?: number;
  positive_ratings?: number;
  review_link_sent?: number;
  review_link_clicks?: number;
  review_click_rate?: number | string;
  by_source?: Record<string, BySourceBucket>;
}

interface Escalation {
  _id: string;
  rating?: number;
  source?: string;
  customer_phone?: string;
  created_at?: string;
  feedback_text?: string;
  status?: string;
  escalation_note?: string;
}

interface EscalationsResponse {
  escalations?: Escalation[];
}

interface ReviewLinks {
  google_review_link?: string | null;
  zomato_review_link?: string | null;
}

interface DineInBody {
  phone: string;
  customer_name?: string;
  order_ref?: string;
}

// --- Ratings types (merged in from the former standalone ratings page) ---

interface RatingComment {
  comment?: string;
  overall_rating?: number;
  created_at?: string;
}

interface RatingsSummary {
  total?: number;
  avg_overall?: number | string;
  avg_taste?: number | string;
  avg_packing?: number | string;
  avg_delivery?: number | string;
  avg_value?: number | string;
  recent_comments?: RatingComment[];
}

interface RatingRow {
  id?: string;
  order_number: string;
  customer_name?: string;
  branch_name?: string;
  taste_rating?: number;
  packing_rating?: number;
  delivery_rating?: number;
  value_rating?: number;
  overall_rating?: number;
  comment?: string;
  created_at?: string;
}

interface RatingsListResponse {
  total: number;
  pages: number;
  ratings: RatingRow[];
}

type Window = '30d' | 'all';
type MsgState = { kind: 'ok' | 'err'; text: string } | null;

function ratingColor(v: number | undefined | null): string {
  const n = Number(v) || 0;
  if (n >= 4) return 'var(--wa)';
  if (n >= 3) return 'var(--gold)';
  if (n > 0) return 'var(--red)';
  return 'var(--dim)';
}

function RatingBadge({ value }: { value?: number | undefined }) {
  return (
    // colour from ratingColor() at runtime based on numeric rating
    <span className="font-semibold" style={{ color: ratingColor(value) }}>
      {value || '—'}
    </span>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
  });
}

function formatShortDate(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  });
}

// Ratings-tab data, grouped so the Rating Overview signature stays tidy
// under strict TS. All of this is sourced from the former ratings page's
// API calls (getBranches / getRatingsSummary / getRatings) — unchanged.
interface RatingsData {
  branches: Branch[];
  branchId: string;
  onBranchChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  summary: RatingsSummary | null;
  summaryLoading: boolean;
  summaryErr: string | null;
  onSummaryRetry: () => void;
  list: RatingsListResponse | null;
  listLoading: boolean;
  listErr: string | null;
  onListRetry: () => void;
  page: number;
  onPageChange: (p: number) => void;
}

interface RatingOverviewProps {
  stats: FeedbackStats | null;
  loading: boolean;
  err: string | null;
  onRetry: () => void;
  window: Window;
  onWindowChange: (w: Window) => void;
  ratings: RatingsData;
}

function RatingOverview({ stats, loading, err, onRetry, window, onWindowChange, ratings }: RatingOverviewProps) {
  const bySource = stats?.by_source || {};
  const totalRatings = stats?.total_ratings || 0;
  const positive = stats?.positive_ratings || 0;
  const positivePct = totalRatings ? Math.round((positive / totalRatings) * 100) : 0;

  const {
    branches,
    branchId,
    onBranchChange,
    summary,
    summaryLoading,
    summaryErr,
    onSummaryRetry,
    list,
    listLoading,
    listErr,
    onListRetry,
    page,
    onPageChange,
  } = ratings;

  const summaryTotal = summary?.total ?? 0;
  const showValue = (v: number | string): number | string => (summaryTotal ? v : '—');

  return (
    <div className="mb-4">
      <div className="card mb-4">
        <div className="ch items-center">
          <h3 className="m-0">Unified Rating Overview</h3>
          <div className="ml-auto flex gap-1.5">
            <button
              type="button"
              className={window === '30d' ? 'btn-p btn-sm' : 'btn-g btn-sm'}
              onClick={() => onWindowChange('30d')}
            >
              30 days
            </button>
            <button
              type="button"
              className={window === 'all' ? 'btn-p btn-sm' : 'btn-g btn-sm'}
              onClick={() => onWindowChange('all')}
            >
              All time
            </button>
          </div>
        </div>
        <div className="cb text-sm text-dim">
          Combines post-delivery ratings and merchant-triggered dine-in feedback into one view.
        </div>
      </div>

      {/* Detailed rating breakdown + branch filter (dedicated rating surface,
          merged in from the former standalone ratings page). */}
      <div className="card mb-4">
        <div className="ch flex items-center gap-2.5 flex-wrap">
          <h3 className="mr-auto">Customer Ratings</h3>
          <label className="lbl m-0" htmlFor="rt-branch">Branch</label>
          <select
            id="rt-branch"
            value={branchId}
            onChange={onBranchChange}
            className="min-w-[180px]"
          >
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>

        {summaryErr ? (
          <div className="py-3">
            <SectionError message={summaryErr} onRetry={onSummaryRetry} />
          </div>
        ) : (
          <div className="stats">
            <StatCard
              label="Overall"
              value={summaryLoading ? '—' : showValue(summary?.avg_overall ?? '—')}
              delta="Average rating"
            />
            <StatCard
              label="Taste"
              value={summaryLoading ? '—' : showValue(summary?.avg_taste ?? '—')}
              delta="Average rating"
            />
            <StatCard
              label="Packaging"
              value={summaryLoading ? '—' : showValue(summary?.avg_packing ?? '—')}
              delta="Average rating"
            />
            <StatCard
              label="Delivery"
              value={summaryLoading ? '—' : showValue(summary?.avg_delivery ?? '—')}
              delta="Average rating"
            />
            <StatCard
              label="Value"
              value={summaryLoading ? '—' : showValue(summary?.avg_value ?? '—')}
              delta="Average rating"
            />
            <StatCard
              label="Total Reviews"
              value={summaryLoading ? '—' : (summary?.total || 0)}
              delta="All ratings"
            />
          </div>
        )}
      </div>

      {/* Review funnel (unique to feedback — the duplicate "Average rating"
          card was removed in favour of the detailed breakdown above). */}
      {err ? (
        <SectionError message={err} onRetry={onRetry} />
      ) : (
        <>
          <div className="stats">
            <StatCard
              label="Positive (4–5⭐)"
              value={loading ? '—' : positive.toLocaleString()}
              delta={`${positivePct}% of replies`}
            />
            <StatCard
              label="Review links sent"
              value={loading ? '—' : (stats?.review_link_sent || 0).toLocaleString()}
              delta="Positive ratings nudged"
            />
            <StatCard
              label="Review clicks"
              value={loading ? '—' : (stats?.review_link_clicks || 0).toLocaleString()}
              delta={`${stats?.review_click_rate ?? 0}% click-through`}
            />
          </div>

          <div className="card mt-4">
            <div className="ch"><h3>By source</h3></div>
            <div
              className="cb grid gap-2.5 grid-cols-[repeat(auto-fit,minmax(180px,1fr))]"
            >
              {(['delivery', 'dine_in'] as const).map((src) => (
                <div
                  key={src}
                  className="py-3 px-3 border border-rim rounded-r bg-panel"
                >
                  <div className="text-xs text-dim capitalize">
                    {src.replace('_', '-')}
                  </div>
                  <div className="mt-1">
                    <strong className="text-lg">
                      {bySource[src]?.avg ?? '—'} ⭐
                    </strong>
                    <span className="ml-2 text-sm text-dim">
                      {bySource[src]?.count || 0} ratings
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Recent comments + full ratings table (merged from former ratings page) */}
      <div className="card mt-4 mb-4">
        <div className="ch">
          <h3>Recent Comments</h3>
        </div>
        <div id="rt-comments">
          {summaryLoading ? (
            <span className="text-dim">Loading…</span>
          ) : summary?.recent_comments?.length ? (
            summary.recent_comments.map((c, i) => (
              <div
                key={i}
                className="py-2 border-b border-rim"
              >
                {/* colour from ratingColor() at runtime based on numeric rating */}
                <span className="font-semibold" style={{ color: ratingColor(c.overall_rating || 0) }}>
                  {c.overall_rating || 0}⭐
                </span>{' '}
                <span>{c.comment || ''}</span>{' '}
                <span className="text-dim text-xs float-right">
                  {formatShortDate(c.created_at)}
                </span>
              </div>
            ))
          ) : (
            <span className="text-mute">No comments yet</span>
          )}
        </div>
      </div>

      <div className="card">
        <div className="ch">
          <h3>All Ratings</h3>
          <span id="rt-count" className="text-dim text-sm">
            {list ? `${list.total} total` : ''}
          </span>
        </div>

        {listErr ? (
          <SectionError message={listErr} onRetry={onListRetry} />
        ) : (
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Branch</th>
                  <th className="text-center">Taste</th>
                  <th className="text-center">Packing</th>
                  <th className="text-center">Delivery</th>
                  <th className="text-center">Value</th>
                  <th className="text-center">Overall</th>
                  <th>Comment</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody id="rt-tbody">
                {listLoading ? (
                  <tr>
                    <td colSpan={10} className="text-center p-8 text-dim">
                      Loading…
                    </td>
                  </tr>
                ) : !list?.ratings?.length ? (
                  <tr>
                    <td colSpan={10} className="text-center p-8 text-dim">
                      No ratings yet. Ratings will appear here after customers rate their orders.
                    </td>
                  </tr>
                ) : (
                  list.ratings.map((r, i) => (
                    <tr key={r.id || `${r.order_number}-${i}`} className="border-b border-rim">
                      <td><span className="mono">#{r.order_number}</span></td>
                      <td>{r.customer_name || ''}</td>
                      <td>{r.branch_name}</td>
                      <td className="text-center"><RatingBadge value={r.taste_rating} /></td>
                      <td className="text-center"><RatingBadge value={r.packing_rating} /></td>
                      <td className="text-center"><RatingBadge value={r.delivery_rating} /></td>
                      <td className="text-center"><RatingBadge value={r.value_rating} /></td>
                      <td className="text-center"><RatingBadge value={r.overall_rating} /></td>
                      <td
                        className="max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap"
                        title={r.comment || ''}
                      >
                        {r.comment || <span className="text-mute">—</span>}
                      </td>
                      <td className="text-dim">{formatDate(r.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {list && list.pages > 1 && (
          <div
            id="rt-pager"
            className="flex gap-1 flex-wrap mt-3"
          >
            {Array.from({ length: list.pages }, (_, i) => i + 1).map((p) => {
              const active = p === page;
              const borderCls = active ? 'border border-acc' : 'border border-rim';
              const bgCls = active ? 'bg-acc text-white' : 'bg-white text-tx';
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPageChange(p)}
                  className={`py-1 px-2.5 rounded-r cursor-pointer text-xs ${borderCls} ${bgCls}`}
                >
                  {p}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface EscalationInboxProps {
  escalations: Escalation[];
  loading: boolean;
  err: string | null;
  onRetry: () => void;
  includeResolved: boolean;
  onToggleResolved: (v: boolean) => void;
  onResolve: (id: string, note: string) => Promise<void>;
}

function EscalationInbox({ escalations, loading, err, onRetry, includeResolved, onToggleResolved, onResolve }: EscalationInboxProps) {
  if (err) return <SectionError message={err} onRetry={onRetry} />;
  const rows = escalations || [];
  return (
    <div className="card mb-4">
      <div className="ch items-center">
        <h3 className="m-0">Escalation Inbox</h3>
        <label className="ml-auto text-sm text-dim inline-flex gap-1.5 items-center">
          <input type="checkbox" checked={includeResolved} onChange={(e) => onToggleResolved(e.target.checked)} />
          Show resolved
        </label>
      </div>
      <div className="cb">
        {loading ? (
          <div className="text-sm text-dim">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-dim">
            No open escalations — nice work.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((e) => (
              <EscalationRow key={e._id} item={e} onResolve={onResolve} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface EscalationRowProps {
  item: Escalation;
  onResolve: (id: string, note: string) => Promise<void>;
}

function EscalationRow({ item, onResolve }: EscalationRowProps) {
  const [busy, setBusy] = useState<boolean>(false);
  const [note, setNote] = useState<string>('');
  const [showNote, setShowNote] = useState<boolean>(false);
  const isOpen = item.status === 'escalated';

  async function doResolve() {
    setBusy(true);
    try {
      await onResolve(item._id, note);
    } finally {
      setBusy(false);
      setShowNote(false);
      setNote('');
    }
  }

  return (
    <div
      className={`py-2.5 px-3 border border-rim rounded-r ${isOpen ? 'bg-[#fff7ed]' : 'bg-[#f8fafc]'}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <strong className="text-base">
          {item.rating ? `${item.rating}⭐` : '—'}
        </strong>
        <span className="text-xs text-dim">
          {item.source ? item.source.replace('_', '-') : ''}
        </span>
        {item.customer_phone && (
          <span className="text-xs text-dim">
            {item.customer_phone}
          </span>
        )}
        <span className="ml-auto text-xs text-dim">
          {item.created_at ? new Date(item.created_at).toLocaleString() : ''}
        </span>
      </div>
      {item.feedback_text && (
        <div className="text-sm mt-1.5">{item.feedback_text}</div>
      )}
      {item.status === 'resolved' && item.escalation_note && (
        <div className="text-xs text-dim mt-1">
          Resolved note: {item.escalation_note}
        </div>
      )}
      {isOpen && (
        <div className="mt-2 flex gap-1.5 items-center">
          {showNote ? (
            <>
              <input
                type="text"
                value={note}
                placeholder="Optional note"
                onChange={(ev) => setNote(ev.target.value)}
                className="flex-1 py-1.5 px-2 border border-rim rounded-r"
              />
              <button type="button" className="btn-p btn-sm" disabled={busy} onClick={doResolve}>
                {busy ? 'Saving…' : 'Mark resolved'}
              </button>
              <button type="button" className="btn-g btn-sm" disabled={busy} onClick={() => { setShowNote(false); setNote(''); }}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="btn-p btn-sm" onClick={() => setShowNote(true)}>
              Mark resolved
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface SendDineInProps {
  onSend: (body: DineInBody) => Promise<void>;
}

function SendDineIn({ onSend }: SendDineInProps) {
  const [phone, setPhone] = useState<string>('');
  const [customerName, setCustomerName] = useState<string>('');
  const [orderRef, setOrderRef] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<MsgState>(null);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setMsg(null);
    if (!phone.trim()) {
      setMsg({ kind: 'err', text: 'Phone is required' });
      return;
    }
    setBusy(true);
    try {
      const body: DineInBody = { phone: phone.trim() };
      if (customerName.trim()) body.customer_name = customerName.trim();
      if (orderRef.trim()) body.order_ref = orderRef.trim();
      await onSend(body);
      setMsg({ kind: 'ok', text: 'Feedback prompt sent via WhatsApp.' });
      setPhone('');
      setCustomerName('');
      setOrderRef('');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const reason = e?.response?.data?.error || e?.message || 'Send failed';
      setMsg({ kind: 'err', text: reason });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card mb-4" onSubmit={submit}>
      <div className="ch"><h3>Send Dine-in Feedback</h3></div>
      <div
        className="cb grid gap-3 grid-cols-[repeat(auto-fit,minmax(220px,1fr))]"
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm text-dim">Customer phone</span>
          <input
            type="tel"
            inputMode="numeric"
            placeholder="91XXXXXXXXXX"
            value={phone}
            onChange={(ev) => setPhone(ev.target.value)}
            className="py-2 px-2 border border-rim rounded-r bg-white"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-dim">Customer name (optional)</span>
          <input
            type="text"
            value={customerName}
            onChange={(ev) => setCustomerName(ev.target.value)}
            className="py-2 px-2 border border-rim rounded-r bg-white"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-dim">Order / table ref (optional)</span>
          <input
            type="text"
            placeholder="e.g. T4-bill-1288"
            value={orderRef}
            onChange={(ev) => setOrderRef(ev.target.value)}
            className="py-2 px-2 border border-rim rounded-r bg-white"
          />
        </label>
      </div>
      {msg && (
        <div className={`cb text-sm ${msg.kind === 'ok' ? 'text-wa' : 'text-red'}`}>
          {msg.text}
        </div>
      )}
      <div className="cb flex justify-end">
        <button type="submit" className="btn-p btn-sm" disabled={busy}>
          {busy ? 'Sending…' : 'Send prompt'}
        </button>
      </div>
    </form>
  );
}

interface ReviewLinksSettingsProps {
  links: ReviewLinks | null;
  onSave: (body: ReviewLinks) => Promise<void>;
}

function ReviewLinksSettings({ links, onSave }: ReviewLinksSettingsProps) {
  const [google, setGoogle] = useState<string>(links?.google_review_link || '');
  const [zomato, setZomato] = useState<string>(links?.zomato_review_link || '');
  const [saving, setSaving] = useState<boolean>(false);
  const [msg, setMsg] = useState<MsgState>(null);

  useEffect(() => {
    setGoogle(links?.google_review_link || '');
    setZomato(links?.zomato_review_link || '');
  }, [links]);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setMsg(null);
    setSaving(true);
    try {
      await onSave({
        google_review_link: google.trim() || null,
        zomato_review_link: zomato.trim() || null,
      });
      setMsg({ kind: 'ok', text: 'Review links saved.' });
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const reason = e?.response?.data?.error || e?.message || 'Save failed';
      setMsg({ kind: 'err', text: reason });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="ch"><h3>Review Links</h3></div>
      <div className="cb text-sm text-dim">
        Positive ratings trigger a WhatsApp nudge with these links (tracked via a short redirect).
      </div>
      <div
        className="cb grid gap-3 grid-cols-[repeat(auto-fit,minmax(260px,1fr))]"
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm text-dim">Google review URL</span>
          <input
            type="url"
            placeholder="https://g.page/r/…/review"
            value={google}
            onChange={(ev) => setGoogle(ev.target.value)}
            className="py-2 px-2 border border-rim rounded-r bg-white"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-dim">Zomato review URL</span>
          <input
            type="url"
            placeholder="https://www.zomato.com/…"
            value={zomato}
            onChange={(ev) => setZomato(ev.target.value)}
            className="py-2 px-2 border border-rim rounded-r bg-white"
          />
        </label>
      </div>
      {msg && (
        <div className={`cb text-sm ${msg.kind === 'ok' ? 'text-wa' : 'text-red'}`}>
          {msg.text}
        </div>
      )}
      <div className="cb flex justify-end">
        <button type="submit" className="btn-p btn-sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save links'}
        </button>
      </div>
    </form>
  );
}

export default function ReputationPage() {
  const [window, setWindow] = useState<Window>('30d');
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState<boolean>(true);

  const [includeResolved, setIncludeResolved] = useState<boolean>(false);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [escErr, setEscErr] = useState<string | null>(null);
  const [escLoading, setEscLoading] = useState<boolean>(true);

  const [links, setLinks] = useState<ReviewLinks | null>(null);

  // --- Ratings state (merged in from the former standalone ratings page) ---
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string>('');
  const [page, setPage] = useState<number>(1);

  const [summary, setSummary] = useState<RatingsSummary | null>(null);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState<boolean>(true);

  const [list, setList] = useState<RatingsListResponse | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState<boolean>(true);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsErr(null);
    try {
      const params = window === '30d' ? { window: '30d' } : {};
      const data = (await getFeedbackStats(params)) as FeedbackStats | null;
      setStats(data || null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setStatsErr(e?.response?.data?.error || e?.message || 'Could not load stats');
    } finally {
      setStatsLoading(false);
    }
  }, [window]);

  const loadEscalations = useCallback(async () => {
    setEscLoading(true);
    setEscErr(null);
    try {
      const data = (await getFeedbackEscalations({ include_resolved: includeResolved })) as EscalationsResponse | null;
      setEscalations(data?.escalations || []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setEscErr(e?.response?.data?.error || e?.message || 'Could not load escalations');
    } finally {
      setEscLoading(false);
    }
  }, [includeResolved]);

  const loadLinks = useCallback(async () => {
    try {
      const data = (await getReviewLinks()) as ReviewLinks | null;
      setLinks(data);
    } catch (_e) {
      setLinks({ google_review_link: null, zomato_review_link: null });
    }
  }, []);

  const loadBranches = useCallback(async () => {
    try {
      const br = await getBranches();
      setBranches(Array.isArray(br) ? br : []);
    } catch {
      setBranches([]);
    }
  }, []);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryErr(null);
    try {
      const params = branchId ? { branch_id: branchId } : {};
      const data = (await getRatingsSummary(params)) as RatingsSummary | null;
      setSummary(data || null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; userMessage?: string; message?: string };
      setSummaryErr(e?.response?.data?.error || e?.userMessage || e?.message || 'Could not load summary');
    } finally {
      setSummaryLoading(false);
    }
  }, [branchId]);

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListErr(null);
    try {
      const params: Record<string, string | number> = { page, limit: PAGE_LIMIT };
      if (branchId) params.branch_id = branchId;
      const data = (await getRatings(params)) as RatingsListResponse | null;
      setList(data || null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; userMessage?: string; message?: string };
      setListErr(e?.response?.data?.error || e?.userMessage || e?.message || 'Could not load ratings');
    } finally {
      setListLoading(false);
    }
  }, [branchId, page]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadEscalations(); }, [loadEscalations]);
  useEffect(() => { loadLinks(); }, [loadLinks]);
  useEffect(() => { loadBranches(); }, [loadBranches]);
  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadList(); }, [loadList]);

  async function handleSend(body: DineInBody) {
    await sendDineInFeedback({ ...body });
  }

  async function handleResolve(id: string, note: string) {
    await resolveFeedbackEscalation(id, note || '');
    await loadEscalations();
  }

  async function handleSaveLinks(body: ReviewLinks) {
    const next = (await updateReviewLinks({ ...body })) as ReviewLinks | null;
    setLinks(next);
  }

  function handleBranchChange(e: ChangeEvent<HTMLSelectElement>) {
    setBranchId(e.target.value);
    setPage(1);
  }

  // Page-level pending-approval gate (carried over from the former ratings
  // page) — shown above the tabs before any reputation data is rendered.
  if (isPendingApproval(summaryErr) || isPendingApproval(listErr) || isPendingApproval(statsErr)) {
    return (
      <div id="tab-reputation" className="tab on">
        <PendingApprovalNotice feature="Reputation" />
      </div>
    );
  }

  return (
    <div id="tab-reputation" className="tab on">
      <div className="mb-4">
        <h2 className="m-0">Reputation</h2>
        <div className="text-sm text-dim mt-1">
          Every rating from delivery and dine-in, plus the review funnel that follows.
        </div>
      </div>

      <RatingOverview
        stats={stats}
        loading={statsLoading}
        err={statsErr}
        onRetry={loadStats}
        window={window}
        onWindowChange={setWindow}
        ratings={{
          branches,
          branchId,
          onBranchChange: handleBranchChange,
          summary,
          summaryLoading,
          summaryErr,
          onSummaryRetry: loadSummary,
          list,
          listLoading,
          listErr,
          onListRetry: loadList,
          page,
          onPageChange: setPage,
        }}
      />

      <EscalationInbox
        escalations={escalations}
        loading={escLoading}
        err={escErr}
        onRetry={loadEscalations}
        includeResolved={includeResolved}
        onToggleResolved={setIncludeResolved}
        onResolve={handleResolve}
      />

      <SendDineIn onSend={handleSend} />

      <ReviewLinksSettings links={links} onSave={handleSaveLinks} />
    </div>
  );
}
