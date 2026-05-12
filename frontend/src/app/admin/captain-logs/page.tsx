'use client';

// Admin > Captain Logs — paginated read-only view of captain_inbound_logs.
// Data has a 30-day TTL (backend index). No raw message content is ever
// shown — phone is only a SHA-256 hash; the table renders coarse fields.

import { useCallback, useEffect, useState } from 'react';
import { getCaptainLogs, type CaptainLogQuery } from '../../../api/admin';
import type { CaptainLogEntry } from '../../../types';

const TH_CLS = 'py-2.5 px-3 text-left text-xs text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2.5 px-3 align-top';
const PAGE_LIMIT = 50;

function fmtTs(iso: string | undefined | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN'); } catch { return '—'; }
}

export default function AdminCaptainLogsPage() {
  const [cityIdInput, setCityIdInput] = useState<string>('');
  const [hadErrorFilter, setHadErrorFilter] = useState<'' | 'true' | 'false'>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  const [rows, setRows] = useState<CaptainLogEntry[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: CaptainLogQuery = { page, limit: PAGE_LIMIT };
      if (cityIdInput.trim()) params.city_id = cityIdInput.trim();
      if (hadErrorFilter === 'true' || hadErrorFilter === 'false') params.had_error = hadErrorFilter;
      if (fromDate) params.from = new Date(fromDate).toISOString();
      if (toDate) {
        // Treat the to-date as end-of-day inclusive.
        const t = new Date(toDate);
        t.setHours(23, 59, 59, 999);
        params.to = t.toISOString();
      }
      const data = await getCaptainLogs(params);
      setRows(data.results);
      setTotal(data.total);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load captain logs';
      setError(msg);
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, cityIdInput, hadErrorFilter, fromDate, toDate]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  // Reset page to 1 when filters change.
  useEffect(() => {
    setPage(1);
  }, [cityIdInput, hadErrorFilter, fromDate, toDate]);

  const hasPrev = page > 1;
  const hasNext = page * PAGE_LIMIT < total;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold">Captain Logs</h1>
        <p className="text-dim text-sm">Captain inbound (last 30 days)</p>
      </div>

      <div className="card">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex flex-col gap-1 text-xs text-dim">
            <span>City ID</span>
            <input
              className="inp"
              type="text"
              value={cityIdInput}
              placeholder="city_id"
              onChange={(e) => setCityIdInput(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-dim">
            <span>Had error</span>
            <select
              className="inp"
              value={hadErrorFilter}
              onChange={(e) => setHadErrorFilter(e.target.value as '' | 'true' | 'false')}
            >
              <option value="">Any</option>
              <option value="true">Errors only</option>
              <option value="false">No errors</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-dim">
            <span>From</span>
            <input
              className="inp"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-dim">
            <span>To</span>
            <input
              className="inp"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </label>
        </div>
      </div>

      {error && (
        <div className="notice warn">{error}</div>
      )}

      <div className="card">
        {loading ? (
          <div className="flex flex-col gap-2">
            <div className="h-6 w-full bg-white/5 rounded animate-pulse" />
            <div className="h-6 w-full bg-white/5 rounded animate-pulse" />
            <div className="h-6 w-full bg-white/5 rounded animate-pulse" />
            <div className="h-6 w-full bg-white/5 rounded animate-pulse" />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-dim text-sm py-6 text-center">No logs in this window.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={TH_CLS}>Timestamp</th>
                  <th className={TH_CLS}>City</th>
                  <th className={TH_CLS}>Message type</th>
                  <th className={TH_CLS}>State</th>
                  <th className={TH_CLS}>Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const key = r.id || r._id || `${r.city_id || ''}-${r.ts}`;
                  return (
                    <tr key={key} className="border-t border-white/5">
                      <td className={TD_CLS}>{fmtTs(r.ts)}</td>
                      <td className={TD_CLS}>{r.city_name || '—'}</td>
                      <td className={TD_CLS}>
                        <span className="chip">{r.message_type}</span>
                      </td>
                      <td className={TD_CLS}>
                        {r.session_state_before} → {r.session_state_after}
                      </td>
                      <td className={TD_CLS}>
                        {r.had_error ? (
                          <span className="chip text-red-600">error</span>
                        ) : (
                          <span className="text-dim">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between mt-3">
          <div className="text-xs text-dim">
            {total > 0
              ? `Page ${page} · showing ${(page - 1) * PAGE_LIMIT + 1}–${Math.min(page * PAGE_LIMIT, total)} of ${total}`
              : '—'}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-g"
              disabled={!hasPrev || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <button
              type="button"
              className="btn-g"
              disabled={!hasNext || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
