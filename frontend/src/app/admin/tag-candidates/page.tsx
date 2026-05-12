'use client';

// Admin > Tag Candidates — review queue for new taxonomy values surfaced by
// the research agent. Inline client.get/patch (not added to admin.ts because
// Subagent B owns that file in parallel).

import { useCallback, useEffect, useMemo, useState } from 'react';
import client from '../../../lib/apiClient';
import { useToast } from '../../../components/Toast';

type CandidateStatus = 'pending' | 'approved' | 'rejected';

interface TagCandidate {
  _id: string;
  tag_field: string;
  candidate_value: string;
  suggested_count: number;
  status: CandidateStatus;
  source_listing_ids?: string[];
  created_at?: string;
}

interface ListResponse {
  total: number;
  page: number;
  limit: number;
  results: TagCandidate[];
}

const STATUS_TABS: { value: CandidateStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const TH_CLS = 'py-2.5 px-3 text-left text-xs text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2.5 px-3 align-top';

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN'); } catch { return '—'; }
}

export default function AdminTagCandidatesPage() {
  const { showToast } = useToast();

  const [statusFilter, setStatusFilter] = useState<CandidateStatus>('pending');
  const [candidates, setCandidates] = useState<TagCandidate[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [limit] = useState<number>(25);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await client.get<ListResponse>('/api/admin/tag-candidates', {
        params: { status: statusFilter, page, limit },
      });
      setCandidates(data.results || []);
      setTotal(data.total || 0);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setError(er?.response?.data?.error || er?.message || 'Failed to load candidates');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page, limit]);

  useEffect(() => { load(); }, [load]);

  const changeFilter = (next: CandidateStatus) => {
    setStatusFilter(next);
    setPage(1);
  };

  const onApprove = useCallback(async (id: string) => {
    const ok = typeof window !== 'undefined'
      ? window.confirm('Add this value to the taxonomy?')
      : true;
    if (!ok) return;
    setRowBusy(id);
    try {
      await client.patch(`/api/admin/tag-candidates/${encodeURIComponent(id)}`, { action: 'approve' });
      showToast('Candidate approved', 'success');
      await load();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Approve failed', 'error');
    } finally {
      setRowBusy(null);
    }
  }, [showToast, load]);

  const onReject = useCallback(async (id: string) => {
    setRowBusy(id);
    try {
      await client.patch(`/api/admin/tag-candidates/${encodeURIComponent(id)}`, { action: 'reject' });
      showToast('Candidate rejected', 'success');
      await load();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Reject failed', 'error');
    } finally {
      setRowBusy(null);
    }
  }, [showToast, load]);

  const totalPages = useMemo<number>(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);
  const prevDisabled = page === 1 || loading;
  const nextDisabled = page * limit >= total || loading;

  return (
    <div id="pg-tag-candidates" className="space-y-4 p-4">
      <div className="card">
        <div className="ch gap-2.5 flex-wrap">
          <h3>Tag Candidates</h3>
          <span className="text-xs text-dim">
            {loading ? '' : `${total} ${statusFilter}`}
          </span>
          <button
            type="button"
            className="btn-g btn-sm ml-auto"
            onClick={load}
            disabled={loading}
          >{loading ? 'Loading…' : '↻ Refresh'}</button>
        </div>
      </div>

      <div className="card">
        <div className="cb">
          <div className="flex flex-wrap gap-2">
            {STATUS_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`chip ${statusFilter === t.value ? 'on' : ''}`}
                onClick={() => changeFilter(t.value)}
              >{t.label}</button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="notice warn">
          <div className="notice-ico">⚠️</div>
          <div className="notice-body">
            <p>{error}</p>
            <button type="button" className="btn-g btn-sm" onClick={load}>Retry</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="cb overflow-x-auto p-0">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-ink border-b border-rim">
                <th className={TH_CLS}>Candidate value</th>
                <th className={TH_CLS}>Tag field</th>
                <th className={TH_CLS}>Suggested count</th>
                <th className={TH_CLS}>Status</th>
                <th className={TH_CLS}>Created</th>
                <th className={TH_CLS}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="p-6 text-center text-dim">Loading…</td></tr>
              ) : candidates.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-0">
                    <div className="text-center text-dim py-8">No {statusFilter} candidates.</div>
                  </td>
                </tr>
              ) : (
                candidates.map((c) => {
                  const busy = rowBusy === c._id;
                  return (
                    <tr key={c._id} className="border-b border-rim">
                      <td className={TD_CLS}>
                        <strong>{c.candidate_value}</strong>
                      </td>
                      <td className={TD_CLS}>
                        <span className="chip">{c.tag_field}</span>
                      </td>
                      <td className={TD_CLS}>{c.suggested_count}</td>
                      <td className={TD_CLS}>
                        <span className="chip">{c.status}</span>
                      </td>
                      <td className={TD_CLS}>{fmtDate(c.created_at)}</td>
                      <td className={TD_CLS}>
                        {c.status === 'pending' ? (
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              type="button"
                              className="bg-green-600 text-white px-3 py-1 rounded text-xs disabled:opacity-40"
                              disabled={busy}
                              onClick={() => onApprove(c._id)}
                            >{busy ? '…' : 'Approve'}</button>
                            <button
                              type="button"
                              className="border border-red-500 text-red-600 px-3 py-1 rounded text-xs disabled:opacity-40"
                              disabled={busy}
                              onClick={() => onReject(c._id)}
                            >{busy ? '…' : 'Reject'}</button>
                          </div>
                        ) : (
                          <span className="text-xs text-dim">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="cb flex items-center justify-between gap-2">
          <button
            type="button"
            className="btn-g btn-sm"
            disabled={prevDisabled}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >← Prev</button>
          <span className="text-xs text-dim">
            Page {page} of {totalPages} · {total} total
          </span>
          <button
            type="button"
            className="btn-g btn-sm"
            disabled={nextDisabled}
            onClick={() => setPage((p) => p + 1)}
          >Next →</button>
        </div>
      </div>
    </div>
  );
}
