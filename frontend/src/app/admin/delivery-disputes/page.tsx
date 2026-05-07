'use client';

// Delivery-disputes overview. Lists every order with a Prorouting
// issue (FLM08 fake-delivery, FLM02 wrong-item, etc.) so admins can
// reconcile against 3PL refund tickets in one place. Distinct from
// /admin/issues, which is the customer-support ticket surface — that
// uses a separate `issues` collection with its own lifecycle.
//
// Read-only by design — close/refund flows live on the existing
// /api/admin/orders/:id/issue/close endpoint and aren't replicated
// here. Refresh on mount; admin can refresh manually for now since
// disputes don't change minute-by-minute.

import { useCallback, useEffect, useState } from 'react';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import { getAdminOrdersWithIssues } from '../../../api/admin';

interface DisputeRow {
  id?: string;
  _id?: string;
  order_number?: string;
  display_order_id?: string;
  business_name?: string | null;
  branch_name?: string | null;
  total_rs?: number;
  prorouting_issue_id?: string;
  prorouting_issue_state?: string;
  prorouting_issue_raised_at?: string;
  prorouting_state?: string;
  delivered_at?: string;
  status?: string;
}

interface DisputesResponse {
  orders?: DisputeRow[];
  total?: number;
}

const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.6rem] px-[0.7rem] align-top';
const EMPTY_CLS = 'p-8 text-center text-dim';

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// Issue-state palette mirrors Prorouting's spec:
//   OPEN   - dispute filed, no LSP response yet
//   PROCESSING / IN-PROGRESS - LSP investigating
//   RESOLVED - LSP responded with resolution
//   CLOSED   - merchant accepted resolution
const ISSUE_STATE_COLORS: Record<string, string> = {
  OPEN:        '#d97706',
  PROCESSING:  '#3b82f6',
  'IN-PROGRESS': '#3b82f6',
  RESOLVED:    'var(--gb-wa-500)',
  CLOSED:      'var(--gb-slate-500)',
};

export default function AdminDeliveryDisputesPage() {
  const [data, setData] = useState<DisputesResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const d = (await getAdminOrdersWithIssues()) as DisputesResponse | null;
      setData(d || null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed to load disputes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const orders = data?.orders ?? [];
  const total = data?.total ?? orders.length;

  return (
    <div id="pg-disputes">
      <div className="card">
        <div className="ch gap-[0.6rem] flex-wrap">
          <h3>Delivery Disputes</h3>
          <span className="text-dim text-[0.75rem]">
            {loading ? '' : `${total} dispute${total === 1 ? '' : 's'}`}
          </span>
          <button
            type="button"
            className="btn-g btn-sm ml-auto"
            onClick={load}
            disabled={loading}
          >
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.82rem]">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={TH_CLS}>Order #</th>
                  <th className={TH_CLS}>Restaurant</th>
                  <th className={TH_CLS}>Branch</th>
                  <th className={TH_CLS}>Issue ID</th>
                  <th className={TH_CLS}>State</th>
                  <th className={TH_CLS}>Raised</th>
                  <th className={TH_CLS}>Delivery State</th>
                  <th className={TH_CLS}>Delivered</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className={EMPTY_CLS}>Loading…</td></tr>
                ) : orders.length === 0 ? (
                  <tr><td colSpan={8} className={EMPTY_CLS}>No disputes raised yet</td></tr>
                ) : (
                  orders.map((o) => {
                    const issueState = o.prorouting_issue_state || 'OPEN';
                    const stateColor = ISSUE_STATE_COLORS[issueState] || 'var(--gb-slate-500)';
                    return (
                      <tr key={o.id || o._id || o.order_number} className="border-b border-rim">
                        <td className={TD_CLS}>
                          {o.display_order_id ? (
                            <>
                              <div className="mono">{o.display_order_id}</div>
                              {o.order_number && (
                                <div className="text-[0.68rem] text-mute font-mono">
                                  {o.order_number}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="mono">#{o.order_number || '—'}</span>
                          )}
                        </td>
                        <td className={TD_CLS}>{o.business_name || '—'}</td>
                        <td className={TD_CLS}>{o.branch_name || '—'}</td>
                        <td className={`${TD_CLS} text-[0.74rem] mono`}>
                          {o.prorouting_issue_id || '—'}
                        </td>
                        <td className={TD_CLS}>
                          <span
                            className="py-[0.15rem] px-2 rounded-sm font-bold text-[0.7rem] uppercase tracking-[0.04em]"
                            // bg/colour come from ISSUE_STATE_COLORS by
                            // o.prorouting_issue_state at runtime
                            // (OPEN/PROCESSING/IN-PROGRESS/RESOLVED/CLOSED
                            // — 5 distinct values; bg uses `${color}22` tint).
                            style={{ background: `${stateColor}22`, color: stateColor }}
                          >
                            {issueState}
                          </span>
                        </td>
                        <td className={`${TD_CLS} text-dim text-[0.74rem]`}>
                          {fmtTime(o.prorouting_issue_raised_at)}
                        </td>
                        <td className={`${TD_CLS} text-[0.74rem]`}>
                          {o.prorouting_state || '—'}
                        </td>
                        <td className={`${TD_CLS} text-dim text-[0.74rem]`}>
                          {fmtTime(o.delivered_at)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
