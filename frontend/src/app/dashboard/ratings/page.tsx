'use client';

import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import PendingApprovalNotice, { isPendingApproval } from '../../../components/restaurant/PendingApprovalNotice';
import {
  getBranches,
  getRatings,
  getRatingsSummary,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

const PAGE_LIMIT = 20;

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

export default function RatingsPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string>('');
  const [page, setPage] = useState<number>(1);

  const [summary, setSummary] = useState<RatingsSummary | null>(null);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState<boolean>(true);

  const [list, setList] = useState<RatingsListResponse | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState<boolean>(true);

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

  useEffect(() => { loadBranches(); }, [loadBranches]);
  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadList(); }, [loadList]);

  const handleBranchChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setBranchId(e.target.value);
    setPage(1);
  };

  const total = summary?.total ?? 0;
  const showValue = (v: number | string): number | string => (total ? v : '—');

  if (isPendingApproval(summaryErr) || isPendingApproval(listErr)) {
    return (
      <div id="tab-ratings" className="tab on">
        <PendingApprovalNotice feature="Ratings" />
      </div>
    );
  }

  return (
    <div id="tab-ratings" className="tab on">
      <div className="card mb-4">
        <div className="ch flex items-center gap-[0.6rem] flex-wrap">
          <h3 className="mr-auto">Customer Ratings</h3>
          <label className="lbl m-0" htmlFor="rt-branch">Branch</label>
          <select
            id="rt-branch"
            value={branchId}
            onChange={handleBranchChange}
            className="min-w-[180px]"
          >
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>

        {summaryErr ? (
          <div className="py-[0.8rem]">
            <SectionError message={summaryErr} onRetry={loadSummary} />
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

      <div className="card mb-4">
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
                <span className="text-dim text-[0.72rem] float-right">
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
          <span id="rt-count" className="text-dim text-[0.8rem]">
            {list ? `${list.total} total` : ''}
          </span>
        </div>

        {listErr ? (
          <SectionError message={listErr} onRetry={loadList} />
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
            className="flex gap-[0.3rem] flex-wrap mt-[0.8rem]"
          >
            {Array.from({ length: list.pages }, (_, i) => i + 1).map((p) => {
              const active = p === page;
              const borderCls = active ? 'border border-acc' : 'border border-rim';
              const bgCls = active ? 'bg-acc text-white' : 'bg-white text-tx';
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPage(p)}
                  className={`py-[0.3rem] px-[0.6rem] rounded-r cursor-pointer text-[0.75rem] ${borderCls} ${bgCls}`}
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
