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

import type { CSSProperties } from 'react';
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

const th: CSSProperties = {
  padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem',
  color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700,
  letterSpacing: '.04em',
};
const td: CSSProperties = { padding: '.6rem .7rem', verticalAlign: 'top' };
const emptyCell: CSSProperties = { padding: '2rem', textAlign: 'center', color: 'var(--dim)' };

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
        <div className="ch" style={{ gap: '.6rem', flexWrap: 'wrap' }}>
          <h3>Delivery Disputes</h3>
          <span style={{ color: 'var(--dim)', fontSize: '.75rem' }}>
            {loading ? '' : `${total} dispute${total === 1 ? '' : 's'}`}
          </span>
          <button
            type="button"
            className="btn-g btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={load}
            disabled={loading}
          >
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>

        {err ? (
          <div className="cb"><SectionError message={err} onRetry={load} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
              <thead>
                <tr style={{ background: 'var(--ink)', borderBottom: '1px solid var(--rim)' }}>
                  <th style={th}>Order #</th>
                  <th style={th}>Restaurant</th>
                  <th style={th}>Branch</th>
                  <th style={th}>Issue ID</th>
                  <th style={th}>State</th>
                  <th style={th}>Raised</th>
                  <th style={th}>Delivery State</th>
                  <th style={th}>Delivered</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} style={emptyCell}>Loading…</td></tr>
                ) : orders.length === 0 ? (
                  <tr><td colSpan={8} style={emptyCell}>No disputes raised yet</td></tr>
                ) : (
                  orders.map((o) => {
                    const issueState = o.prorouting_issue_state || 'OPEN';
                    const stateColor = ISSUE_STATE_COLORS[issueState] || 'var(--gb-slate-500)';
                    return (
                      <tr key={o.id || o._id || o.order_number} style={{ borderBottom: '1px solid var(--rim)' }}>
                        <td style={td}>
                          {o.display_order_id ? (
                            <>
                              <div className="mono">{o.display_order_id}</div>
                              {o.order_number && (
                                <div style={{ fontSize: '.68rem', color: 'var(--mute,var(--dim))', fontFamily: 'monospace' }}>
                                  {o.order_number}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="mono">#{o.order_number || '—'}</span>
                          )}
                        </td>
                        <td style={td}>{o.business_name || '—'}</td>
                        <td style={td}>{o.branch_name || '—'}</td>
                        <td style={{ ...td, fontSize: '.74rem' }} className="mono">
                          {o.prorouting_issue_id || '—'}
                        </td>
                        <td style={td}>
                          <span
                            style={{
                              background: `${stateColor}22`,
                              color: stateColor,
                              padding: '.15rem .5rem',
                              borderRadius: 4,
                              fontWeight: 700,
                              fontSize: '.7rem',
                              textTransform: 'uppercase',
                              letterSpacing: '.04em',
                            }}
                          >
                            {issueState}
                          </span>
                        </td>
                        <td style={{ ...td, color: 'var(--dim)', fontSize: '.74rem' }}>
                          {fmtTime(o.prorouting_issue_raised_at)}
                        </td>
                        <td style={{ ...td, fontSize: '.74rem' }}>
                          {o.prorouting_state || '—'}
                        </td>
                        <td style={{ ...td, color: 'var(--dim)', fontSize: '.74rem' }}>
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
