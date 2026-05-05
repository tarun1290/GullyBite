'use client';

import { useCallback, useEffect, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import { useToast } from '../../Toast';
import { getReferrals, getReferralLinks, requestReferralLink } from '../../../api/restaurant';

const STATUS_COLOR: Record<string, string> = {
  active: '#22c55e',
  converted: '#a78bfa',
  expired: '#6b7280',
};

// Settlement / commission state colour map. Greens = money realised,
// amber = awaiting confirmation, red = clawback, dim = already paid.
const COMMISSION_COLOR: Record<string, string> = {
  pending: '#f59e0b',
  confirmed: '#22c55e',
  settled: '#6b7280',
  reversed: '#ef4444',
};

interface Referral {
  id?: string;
  _id?: string;
  customer_name?: string;
  customer_wa_phone?: string;
  customer_bsuid?: string;
  status?: string;
  commission_status?: string;
  attribution_window_hours?: number;
  orders_count?: number;
  total_order_value_rs?: number | string;
  referral_fee_rs?: number | string;
  created_at?: string;
}

interface ReferralsSummary {
  total?: number | string;
  converted?: number | string;
  total_order_value_rs?: number | string;
  total_referral_fee_rs?: number | string;
}

interface ReferralsResponse {
  summary?: ReferralsSummary;
  referrals?: Referral[];
}

interface ReferralLink {
  id?: string;
  _id?: string;
  code?: string;
  campaign_name?: string | null;
  wa_link?: string;
  click_count?: number;
  status?: string;
  created_at?: string;
}

interface ReferralLinksResponse {
  links?: ReferralLink[];
}

interface RequestLinkResponse {
  success?: boolean;
  already_pending?: boolean;
  message?: string;
}

function formatINR(n?: number | string | null): string {
  return parseFloat(String(n || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function formatDate(d?: string): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function shortBsuid(b?: string): string {
  return b ? `${String(b).slice(0, 12)}…` : '';
}

export default function ReferralsSection() {
  const { showToast } = useToast();
  const { data, loading, error, refetch } = useAnalyticsFetch<ReferralsResponse | null>(
    useCallback(() => getReferrals() as Promise<ReferralsResponse | null>, []),
    [],
  );

  // GBREF links: separate fetch on mount so the card can render alongside
  // the referrals table without coupling either's loading state.
  const [links, setLinks] = useState<ReferralLink[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [requestPending, setRequestPending] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const loadLinks = useCallback(async () => {
    setLinksLoading(true);
    try {
      const r = (await getReferralLinks()) as ReferralLinksResponse | null;
      setLinks(Array.isArray(r?.links) ? r!.links! : []);
      setLinksError(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setLinksError(er?.response?.data?.error || er?.message || 'Failed to load referral links');
      setLinks([]);
    } finally {
      setLinksLoading(false);
    }
  }, []);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  const onCopyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      showToast('Link copied!', 'success');
    } catch {
      showToast('Copy failed — please copy manually', 'error');
    }
  };

  const onRequestLink = async () => {
    if (requesting || requestPending) return;
    setRequesting(true);
    try {
      const res = (await requestReferralLink()) as RequestLinkResponse | null;
      setRequestPending(true);
      showToast(
        res?.message || 'Request submitted! Your link will be ready within 24 hours.',
        'success',
      );
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Request failed', 'error');
    } finally {
      setRequesting(false);
    }
  };

  if (error) {
    return (
      <div className="card" style={{ marginTop: '.4rem' }}>
        <div className="cb">
          <SectionError message={error} onRetry={refetch} />
        </div>
      </div>
    );
  }

  const summary = data?.summary || {};
  const referrals = data?.referrals || [];
  const total = Number(summary.total || 0);
  const converted = Number(summary.converted || 0);
  const convertedPct = total > 0 ? Math.round((converted / total) * 100) : 0;
  const feeWithGst = parseFloat(String(summary.total_referral_fee_rs || 0)) * 1.18;

  return (
    <div>
      {/* ── GBREF Link Card ────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: '1.2rem' }}>
        <div className="ch"><h3>Your GBREF Link</h3></div>
        <div className="cb">
          {linksError ? (
            <SectionError message={linksError} onRetry={loadLinks} />
          ) : linksLoading ? (
            <div style={{ color: 'var(--dim)', fontSize: '.85rem' }}>Loading…</div>
          ) : links.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
              <p style={{ margin: 0, color: 'var(--dim)', fontSize: '.85rem' }}>
                You don&apos;t have a referral link yet. Once admin generates one, share it with
                customers — every order placed within 8 hours of clicking earns you tracked credit.
              </p>
              <div>
                <button
                  type="button"
                  className="btn-p btn-sm"
                  onClick={onRequestLink}
                  disabled={requesting || requestPending}
                  style={{ background: 'var(--gb-violet-600)', color: 'var(--gb-neutral-0)' }}
                >
                  {requestPending ? 'Request pending' : requesting ? 'Submitting…' : 'Request Referral Link'}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '.8rem' }}>
              {links.map((link) => {
                const wa = link.wa_link || '';
                const label = link.campaign_name || 'Default link';
                return (
                  <div
                    key={link.id || link._id || link.code}
                    style={{
                      border: '1px solid var(--rim)',
                      borderRadius: 8,
                      padding: '.85rem 1rem',
                      background: 'var(--ink)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: '.9rem' }}>{label}</strong>
                        <span style={{
                          background: '#22c55e22', color: '#22c55e',
                          fontSize: '.68rem', padding: '.15rem .5rem', borderRadius: 99,
                          textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em',
                        }}>
                          {link.status || 'active'}
                        </span>
                      </div>
                      <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
                        Clicked {link.click_count ?? 0} times
                      </span>
                    </div>
                    <code
                      className="mono"
                      style={{
                        display: 'block',
                        marginTop: '.5rem',
                        fontSize: '.78rem',
                        wordBreak: 'break-all',
                        color: 'var(--dim)',
                      }}
                    >
                      {wa}
                    </code>
                    <div style={{ display: 'flex', gap: '.5rem', marginTop: '.7rem', flexWrap: 'wrap' }}>
                      <a
                        href={wa}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-p btn-sm"
                        style={{ background: '#25D366', color: '#fff', textDecoration: 'none' }}
                      >
                        📲 Share via WhatsApp
                      </a>
                      <button
                        type="button"
                        className="btn-g btn-sm"
                        onClick={() => onCopyLink(wa)}
                      >
                        Copy Link
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Headline stats ─────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '1rem', marginBottom: '1.4rem' }}>
        <div className="card" style={{ padding: '1rem 1.2rem' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{loading && !data ? '…' : total}</div>
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: '.2rem' }}>Total Referrals</div>
        </div>
        <div className="card" style={{ padding: '1rem 1.2rem' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            {loading && !data ? '…' : `${converted}${total > 0 ? ` (${convertedPct}%)` : ''}`}
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: '.2rem' }}>Converted to Orders</div>
        </div>
        <div className="card" style={{ padding: '1rem 1.2rem' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            {loading && !data ? '…' : `₹${formatINR(summary.total_order_value_rs)}`}
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: '.2rem' }}>Total Order Value</div>
        </div>
        <div className="card" style={{ padding: '1rem 1.2rem' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#a78bfa' }}>
            {loading && !data ? '…' : `₹${formatINR(feeWithGst)}`}
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: '.2rem' }}>
            Referral Fees Owed (7.5% + GST)
          </div>
        </div>
      </div>

      {/* ── Info banner ─────────────────────────────────────────
          Tightened the wording per the GBREF spec — explicit on the
          7.5% + GST rate and the settlement deduction. */}
      <div className="card" style={{ marginBottom: '1.2rem', padding: '.85rem 1.2rem', background: '#1e1b4b', border: '1px solid #4c1d9544' }}>
        <p style={{ fontSize: '.82rem', color: '#c4b5fd', margin: 0 }}>
          Customers who click your GBREF link and order within <strong>8 hours</strong> generate a{' '}
          <strong>7.5% + GST</strong> referral fee, deducted from your weekly settlement.
        </p>
      </div>

      <div className="card">
        <div className="ch"><h3>Referrals Received</h3></div>
        <div className="cb" style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--rim)' }}>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Customer</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Status</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Orders</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Order Value</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Referral Fee</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Commission</th>
                <th style={{ padding: '.6rem 1rem', textAlign: 'left', color: 'var(--dim)', fontWeight: 500 }}>Referred On</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={7} style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>Loading…</td></tr>
              ) : referrals.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>No referrals received yet</td></tr>
              ) : (
                referrals.map((r, idx) => (
                  <tr key={r.id || r._id || idx} style={{ borderBottom: '1px solid var(--rim)' }}>
                    <td style={{ padding: '.6rem 1rem' }}>
                      <div style={{ fontFamily: 'monospace', fontSize: '.8rem' }}>
                        {r.customer_wa_phone || shortBsuid(r.customer_bsuid) || '—'}
                      </div>
                      {r.customer_name && (
                        <div style={{ fontSize: '.74rem', color: 'var(--dim)' }}>{r.customer_name}</div>
                      )}
                    </td>
                    <td style={{ padding: '.6rem 1rem' }}>
                      <span style={{ color: STATUS_COLOR[r.status || ''] || '#6b7280', fontWeight: 600, textTransform: 'capitalize', fontSize: '.8rem' }}>
                        {r.status}
                      </span>
                      {r.attribution_window_hours ? (
                        <span style={{ fontSize: '.65rem', color: 'var(--dim)', marginLeft: '.3rem' }}>
                          {r.attribution_window_hours}h window
                        </span>
                      ) : null}
                    </td>
                    <td style={{ padding: '.6rem 1rem' }}>{r.orders_count}</td>
                    <td style={{ padding: '.6rem 1rem' }}>₹{formatINR(r.total_order_value_rs)}</td>
                    <td style={{ padding: '.6rem 1rem', color: '#a78bfa', fontWeight: 600 }}>₹{formatINR(r.referral_fee_rs)}</td>
                    <td style={{ padding: '.6rem 1rem' }}>
                      {r.commission_status ? (
                        <span style={{
                          color: COMMISSION_COLOR[r.commission_status] || '#6b7280',
                          fontWeight: 600,
                          textTransform: 'capitalize',
                          fontSize: '.8rem',
                        }}>
                          {r.commission_status}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--dim)', fontSize: '.8rem' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '.6rem 1rem', fontSize: '.78rem', color: 'var(--dim)' }}>
                      {formatDate(r.created_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
