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
      <div className="card mt-[0.4rem]">
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
      <div className="card mb-[1.2rem]">
        <div className="ch"><h3>Your GBREF Link</h3></div>
        <div className="cb">
          {linksError ? (
            <SectionError message={linksError} onRetry={loadLinks} />
          ) : linksLoading ? (
            <div className="text-dim text-[0.85rem]">Loading…</div>
          ) : links.length === 0 ? (
            <div className="flex flex-col gap-[0.6rem]">
              <p className="m-0 text-dim text-[0.85rem]">
                You don&apos;t have a referral link yet. Once admin generates one, share it with
                customers — every order placed within 8 hours of clicking earns you tracked credit.
              </p>
              <div>
                <button
                  type="button"
                  className="btn-p btn-sm bg-acc text-neutral-0"
                  onClick={onRequestLink}
                  disabled={requesting || requestPending}
                >
                  {requestPending ? 'Request pending' : requesting ? 'Submitting…' : 'Request Referral Link'}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid gap-[0.8rem]">
              {links.map((link) => {
                const wa = link.wa_link || '';
                const label = link.campaign_name || 'Default link';
                return (
                  <div
                    key={link.id || link._id || link.code}
                    className="border border-rim rounded-lg py-[0.85rem] px-4 bg-ink"
                  >
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <strong className="text-[0.9rem]">{label}</strong>
                        <span className="bg-[#22c55e22] text-[#22c55e] text-[0.68rem] py-[0.15rem] px-2 rounded-full uppercase font-bold tracking-[0.04em]">
                          {link.status || 'active'}
                        </span>
                      </div>
                      <span className="text-[0.78rem] text-dim">
                        Clicked {link.click_count ?? 0} times
                      </span>
                    </div>
                    <code className="mono block mt-2 text-[0.78rem] break-all text-dim">
                      {wa}
                    </code>
                    <div className="flex gap-2 mt-[0.7rem] flex-wrap">
                      <a
                        href={wa}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-p btn-sm bg-[#25D366] text-white no-underline"
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
      <div className="grid grid-cols-4 gap-4 mb-[1.4rem]">
        <div className="card py-4 px-[1.2rem]">
          <div className="text-[1.5rem] font-bold">{loading && !data ? '…' : total}</div>
          <div className="text-[0.78rem] text-dim mt-[0.2rem]">Total Referrals</div>
        </div>
        <div className="card py-4 px-[1.2rem]">
          <div className="text-[1.5rem] font-bold">
            {loading && !data ? '…' : `${converted}${total > 0 ? ` (${convertedPct}%)` : ''}`}
          </div>
          <div className="text-[0.78rem] text-dim mt-[0.2rem]">Converted to Orders</div>
        </div>
        <div className="card py-4 px-[1.2rem]">
          <div className="text-[1.5rem] font-bold">
            {loading && !data ? '…' : `₹${formatINR(summary.total_order_value_rs)}`}
          </div>
          <div className="text-[0.78rem] text-dim mt-[0.2rem]">Total Order Value</div>
        </div>
        <div className="card py-4 px-[1.2rem]">
          <div className="text-[1.5rem] font-bold text-[#a78bfa]">
            {loading && !data ? '…' : `₹${formatINR(feeWithGst)}`}
          </div>
          <div className="text-[0.78rem] text-dim mt-[0.2rem]">
            Referral Fees Owed (7.5% + GST)
          </div>
        </div>
      </div>

      {/* ── Info banner ─────────────────────────────────────────
          Tightened the wording per the GBREF spec — explicit on the
          7.5% + GST rate and the settlement deduction. */}
      <div className="card mb-[1.2rem] py-[0.85rem] px-[1.2rem] bg-[#1e1b4b] border border-[#4c1d9544]">
        <p className="text-[0.82rem] text-[#c4b5fd] m-0">
          Customers who click your GBREF link and order within <strong>8 hours</strong> generate a{' '}
          <strong>7.5% + GST</strong> referral fee, deducted from your weekly settlement.
        </p>
      </div>

      <div className="card">
        <div className="ch"><h3>Referrals Received</h3></div>
        <div className="cb p-0">
          <table className="w-full border-collapse text-[0.82rem]">
            <thead>
              <tr className="border-b border-rim">
                <th className="py-[0.6rem] px-4 text-left text-dim font-medium">Customer</th>
                <th className="py-[0.6rem] px-4 text-left text-dim font-medium">Status</th>
                <th className="py-[0.6rem] px-4 text-left text-dim font-medium">Orders</th>
                <th className="py-[0.6rem] px-4 text-left text-dim font-medium">Order Value</th>
                <th className="py-[0.6rem] px-4 text-left text-dim font-medium">Referral Fee</th>
                <th className="py-[0.6rem] px-4 text-left text-dim font-medium">Commission</th>
                <th className="py-[0.6rem] px-4 text-left text-dim font-medium">Referred On</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={7} className="p-8 text-center text-dim">Loading…</td></tr>
              ) : referrals.length === 0 ? (
                <tr><td colSpan={7} className="p-8 text-center text-dim">No referrals received yet</td></tr>
              ) : (
                referrals.map((r, idx) => (
                  <tr key={r.id || r._id || idx} className="border-b border-rim">
                    <td className="py-[0.6rem] px-4">
                      <div className="font-mono text-[0.8rem]">
                        {r.customer_wa_phone || shortBsuid(r.customer_bsuid) || '—'}
                      </div>
                      {r.customer_name && (
                        <div className="text-[0.74rem] text-dim">{r.customer_name}</div>
                      )}
                    </td>
                    <td className="py-[0.6rem] px-4">
                      <span
                        className="font-semibold capitalize text-[0.8rem]"
                        // colour comes from the per-status STATUS_COLOR
                        // palette at runtime — Tailwind can't pre-bake
                        // the dynamic hex.
                        style={{ color: STATUS_COLOR[r.status || ''] || '#6b7280' }}
                      >
                        {r.status}
                      </span>
                      {r.attribution_window_hours ? (
                        <span className="text-[0.65rem] text-dim ml-[0.3rem]">
                          {r.attribution_window_hours}h window
                        </span>
                      ) : null}
                    </td>
                    <td className="py-[0.6rem] px-4">{r.orders_count}</td>
                    <td className="py-[0.6rem] px-4">₹{formatINR(r.total_order_value_rs)}</td>
                    <td className="py-[0.6rem] px-4 text-[#a78bfa] font-semibold">₹{formatINR(r.referral_fee_rs)}</td>
                    <td className="py-[0.6rem] px-4">
                      {r.commission_status ? (
                        <span
                          className="font-semibold capitalize text-[0.8rem]"
                          // colour comes from the per-state
                          // COMMISSION_COLOR palette at runtime.
                          style={{ color: COMMISSION_COLOR[r.commission_status] || '#6b7280' }}
                        >
                          {r.commission_status}
                        </span>
                      ) : (
                        <span className="text-dim text-[0.8rem]">—</span>
                      )}
                    </td>
                    <td className="py-[0.6rem] px-4 text-[0.78rem] text-dim">
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
