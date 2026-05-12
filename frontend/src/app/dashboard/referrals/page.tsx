'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import {
  getCaptainListing,
  getReferralLinks,
  getReferrals,
  requestReferralLink,
} from '../../../api/restaurant';
import type {
  CaptainListingStatus,
  RestaurantReferral,
  RestaurantReferralLink,
  RestaurantReferralsSummary,
} from '../../../types';

// Axios-style error envelope — surfaced by apiClient as
// .response.data.error for 4xx responses. Same shape used by the
// captain-listing page; replicated locally so this file doesn't
// reach into the api/ folder for a type that isn't exported.
interface ApiError {
  response?: { data?: { error?: string } };
  message?: string;
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as ApiError;
  return e?.response?.data?.error || e?.message || fallback;
}

function formatINR(n: number | string | undefined | null): string {
  const v = parseFloat(String(n ?? 0));
  if (Number.isNaN(v)) return '0.00';
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const EMPTY_SUMMARY: RestaurantReferralsSummary = {
  total: 0,
  converted: 0,
  total_orders: 0,
  total_order_value_rs: 0,
  total_referral_fee_rs: 0,
};

export default function ReferralsPage() {
  const { showToast } = useToast();

  const [listing, setListing] = useState<CaptainListingStatus | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [listingLoading, setListingLoading] = useState<boolean>(true);

  const [summary, setSummary] = useState<RestaurantReferralsSummary>(EMPTY_SUMMARY);
  const [referrals, setReferrals] = useState<RestaurantReferral[]>([]);
  const [referralsError, setReferralsError] = useState<string | null>(null);
  const [referralsLoading, setReferralsLoading] = useState<boolean>(true);

  const [links, setLinks] = useState<RestaurantReferralLink[]>([]);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [linksLoading, setLinksLoading] = useState<boolean>(true);

  const [requesting, setRequesting] = useState<boolean>(false);

  // Parallel boot via Promise.allSettled — any single section can fail
  // without blocking the others. Per-section errors render an inline
  // .notice.warn so the page never crashes outright.
  const loadAll = useCallback(async () => {
    setListingLoading(true);
    setReferralsLoading(true);
    setLinksLoading(true);
    const [listingRes, refRes, linksRes] = await Promise.allSettled([
      getCaptainListing(),
      getReferrals(),
      getReferralLinks(),
    ]);

    if (listingRes.status === 'fulfilled') {
      setListing(listingRes.value);
      setListingError(null);
    } else {
      setListing(null);
      setListingError(errorMessage(listingRes.reason, 'Could not load listing status'));
    }
    setListingLoading(false);

    if (refRes.status === 'fulfilled') {
      const value = refRes.value;
      setSummary(value?.summary ?? EMPTY_SUMMARY);
      setReferrals(Array.isArray(value?.referrals) ? value.referrals : []);
      setReferralsError(null);
    } else {
      setSummary(EMPTY_SUMMARY);
      setReferrals([]);
      setReferralsError(errorMessage(refRes.reason, 'Could not load referrals'));
    }
    setReferralsLoading(false);

    if (linksRes.status === 'fulfilled') {
      setLinks(Array.isArray(linksRes.value?.links) ? linksRes.value.links : []);
      setLinksError(null);
    } else {
      setLinks([]);
      setLinksError(errorMessage(linksRes.reason, 'Could not load referral links'));
    }
    setLinksLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const reloadLinks = useCallback(async () => {
    setLinksLoading(true);
    try {
      const value = await getReferralLinks();
      setLinks(Array.isArray(value?.links) ? value.links : []);
      setLinksError(null);
    } catch (err: unknown) {
      setLinksError(errorMessage(err, 'Could not load referral links'));
      setLinks([]);
    } finally {
      setLinksLoading(false);
    }
  }, []);

  const onRequestLink = useCallback(async () => {
    if (requesting) return;
    setRequesting(true);
    try {
      const res = await requestReferralLink();
      if (res?.already_pending) {
        showToast(res?.message || 'A request is already pending.', 'info');
      } else {
        showToast(res?.message || 'Request submitted! Your link will be ready shortly.', 'success');
      }
      await reloadLinks();
    } catch (err: unknown) {
      showToast(errorMessage(err, 'Request failed'), 'error');
    } finally {
      setRequesting(false);
    }
  }, [requesting, reloadLinks, showToast]);

  const onCopyLink = useCallback(async (waLink: string | undefined, code: string) => {
    const text = waLink || `https://wa.me/?text=${encodeURIComponent(code)}`;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Link copied!', 'success');
    } catch {
      showToast('Copy failed — please copy manually', 'error');
    }
  }, [showToast]);

  // Detection: if zero rows carry a `source` field, drop the column
  // entirely (graceful degradation while backend rolls out the field).
  const hasSourceField = referrals.some((r) => typeof r.source === 'string');

  const recent = referrals.slice(0, 10);

  return (
    <div id="tab-referrals">
      <div className="mb-4">
        <h2 className="m-0">GullyBite Referrals</h2>
        <div className="text-sm text-dim mt-1">
          Track listings, links, and the orders they bring in — all from one place.
        </div>
      </div>

      {/* ── SECTION 1 — Discovery status ───────────────────────── */}
      <DiscoverySection
        listing={listing}
        loading={listingLoading}
        error={listingError}
      />

      {/* ── SECTION 2 — Referral performance ───────────────────── */}
      <PerformanceSection
        summary={summary}
        loading={referralsLoading}
        error={referralsError}
      />

      {/* ── SECTION 3 — Active GBREF links ──────────────────────── */}
      <LinksSection
        links={links}
        loading={linksLoading}
        error={linksError}
        requesting={requesting}
        onRequest={onRequestLink}
        onCopy={onCopyLink}
      />

      {/* ── SECTION 4 — Recent referrals ────────────────────────── */}
      <RecentReferralsSection
        referrals={recent}
        loading={referralsLoading}
        error={referralsError}
        hasSourceField={hasSourceField}
      />
    </div>
  );
}

// ── Section 1: Discovery status ───────────────────────────────────

interface DiscoverySectionProps {
  listing: CaptainListingStatus | null;
  loading: boolean;
  error: string | null;
}

function DiscoverySection({ listing, loading, error }: DiscoverySectionProps) {
  if (loading) {
    return (
      <div className="card">
        <div className="ch"><h3 className="m-0">Discovery</h3></div>
        <div className="cb text-sm text-dim">Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="card">
        <div className="ch"><h3 className="m-0">Discovery</h3></div>
        <div className="cb">
          <div className="notice warn">{error}</div>
        </div>
      </div>
    );
  }
  if (!listing || listing.linked === false) {
    return (
      <div className="card">
        <div className="ch"><h3 className="m-0">Discovery</h3></div>
        <div className="cb">
          <div className="notice">
            Claim your listing to get discovered on GullyBite Explore.{' '}
            <Link href="/dashboard/captain-listing" className="text-acc">
              Claim your listing →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const l = listing.listing;
  const cityName = listing.city?.name || '—';
  const handoffActive = l?.fulfillment_mode === 'handoff';
  const unfulfilled = listing.notify_counts?.unfulfilled ?? 0;

  return (
    <div className="card">
      <div className="ch"><h3 className="m-0">Discovery</h3></div>
      <div className="cb">
        <div className="flex flex-col gap-2">
          <div>
            <div className="font-semibold text-base">{l?.name || 'Your listing'}</div>
            <div className="text-xs text-dim mt-0.5">{cityName}</div>
          </div>
          <div className="flex flex-wrap gap-2 mt-1">
            {l?.area ? <span className="chip">{l.area}</span> : null}
            {handoffActive ? (
              <span className="chip on">Handoff — active</span>
            ) : (
              <span className="chip">Notify only</span>
            )}
            {unfulfilled > 0 ? (
              <span className="chip on text-xs">{unfulfilled} waiting</span>
            ) : null}
          </div>
          <div className="mt-2">
            <Link href="/dashboard/captain-listing" className="text-sm text-dim hover:text-acc">
              Manage listing →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section 2: Referral performance ───────────────────────────────

interface PerformanceSectionProps {
  summary: RestaurantReferralsSummary;
  loading: boolean;
  error: string | null;
}

function PerformanceSection({ summary, loading, error }: PerformanceSectionProps) {
  return (
    <div className="card">
      <div className="ch"><h3 className="m-0">Referral performance</h3></div>
      <div className="cb">
        {error ? (
          <div className="notice warn">{error}</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="stat">
              <div className="stat-l">Total Referrals</div>
              <div className="stat-v">{loading ? '…' : summary.total}</div>
            </div>
            <div className="stat">
              <div className="stat-l">Converted Orders</div>
              <div className="stat-v">{loading ? '…' : summary.converted}</div>
            </div>
            <div className="stat">
              <div className="stat-l">Total Commission Earned</div>
              <div className="stat-v">
                {loading ? '…' : `₹${formatINR(summary.total_referral_fee_rs)}`}
              </div>
            </div>
            <div className="stat">
              <div className="stat-l">Pending Payout</div>
              <div className="stat-v text-base">
                <Link href="/dashboard/payments" className="text-acc">
                  See settlements →
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section 3: Active GBREF links ─────────────────────────────────

interface LinksSectionProps {
  links: RestaurantReferralLink[];
  loading: boolean;
  error: string | null;
  requesting: boolean;
  onRequest: () => void;
  onCopy: (waLink: string | undefined, code: string) => void;
}

function LinksSection({
  links,
  loading,
  error,
  requesting,
  onRequest,
  onCopy,
}: LinksSectionProps) {
  return (
    <div className="card">
      <div className="ch">
        <h3 className="m-0">Active GBREF links</h3>
        <button
          type="button"
          className="btn-g"
          onClick={onRequest}
          disabled={requesting}
        >
          {requesting ? 'Requesting…' : 'Request a tracking link'}
        </button>
      </div>
      <div className="cb">
        {error ? (
          <div className="notice warn">{error}</div>
        ) : loading ? (
          <div className="text-sm text-dim">Loading…</div>
        ) : links.length === 0 ? (
          <div className="notice">No active referral links. Request one below.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-rim">
                  <th className="py-2.5 px-3 text-left text-dim font-medium">Code</th>
                  <th className="py-2.5 px-3 text-left text-dim font-medium">Created</th>
                  <th className="py-2.5 px-3 text-left text-dim font-medium">Click count</th>
                  <th className="py-2.5 px-3 text-left text-dim font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id || link._id || link.code} className="border-b border-rim">
                    <td className="py-2.5 px-3">
                      <code className="font-mono text-sm">{link.code}</code>
                      {link.campaign_name ? (
                        <div className="text-xs text-dim mt-0.5">{link.campaign_name}</div>
                      ) : null}
                    </td>
                    <td className="py-2.5 px-3 text-sm text-dim">
                      {formatDate(link.created_at)}
                    </td>
                    <td className="py-2.5 px-3">{link.click_count ?? 0}</td>
                    <td className="py-2.5 px-3">
                      <button
                        type="button"
                        className="btn-g"
                        onClick={() => onCopy(link.wa_link, link.code)}
                      >
                        Copy
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section 4: Recent referrals ───────────────────────────────────

interface RecentReferralsSectionProps {
  referrals: RestaurantReferral[];
  loading: boolean;
  error: string | null;
  hasSourceField: boolean;
}

function sourceBadge(source?: string) {
  if (source === 'city_captain') {
    return <span className="chip">Captain 🏙️</span>;
  }
  if (source === 'city_captain_reengagement') {
    return <span className="chip">Reengaged 🔔</span>;
  }
  return <span className="chip">Direct</span>;
}

function RecentReferralsSection({
  referrals,
  loading,
  error,
  hasSourceField,
}: RecentReferralsSectionProps) {
  // Prefer total_order_value_rs (window total across all attributed
  // orders); fall back to attributed_order_subtotal if the former is
  // missing/zero — the latter is the single-order subtotal that the
  // commission was actually computed against.
  const orderValueFor = (r: RestaurantReferral): number | string | undefined => {
    const total = parseFloat(String(r.total_order_value_rs ?? 0));
    if (total > 0) return r.total_order_value_rs;
    return r.attributed_order_subtotal ?? r.total_order_value_rs;
  };

  // Column count for empty/loading cells. Header is fixed at Date,
  // Order Value, Commission (+ optional Source).
  const colCount = hasSourceField ? 4 : 3;

  return (
    <div className="card">
      <div className="ch"><h3 className="m-0">Recent referrals</h3></div>
      <div className="cb">
        {error ? (
          <div className="notice warn">{error}</div>
        ) : loading ? (
          <div className="text-sm text-dim">Loading…</div>
        ) : referrals.length === 0 ? (
          <div className="text-dim text-sm">
            No referrals yet. Your referred orders will appear here.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-rim">
                  <th className="py-2.5 px-3 text-left text-dim font-medium">Date</th>
                  <th className="py-2.5 px-3 text-left text-dim font-medium">Order Value</th>
                  <th className="py-2.5 px-3 text-left text-dim font-medium">Commission</th>
                  {hasSourceField && (
                    <th className="py-2.5 px-3 text-left text-dim font-medium">Source</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {referrals.length === 0 ? (
                  <tr>
                    <td colSpan={colCount} className="p-8 text-center text-dim">
                      No referrals yet.
                    </td>
                  </tr>
                ) : (
                  referrals.map((r, idx) => (
                    <tr key={r.id || r._id || idx} className="border-b border-rim">
                      <td className="py-2.5 px-3 text-sm text-dim">
                        {formatDate(r.created_at)}
                      </td>
                      <td className="py-2.5 px-3">₹{formatINR(orderValueFor(r))}</td>
                      <td className="py-2.5 px-3 text-violet-400 font-semibold">
                        ₹{formatINR(r.referral_fee_rs)}
                      </td>
                      {hasSourceField && (
                        <td className="py-2.5 px-3">{sourceBadge(r.source)}</td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
