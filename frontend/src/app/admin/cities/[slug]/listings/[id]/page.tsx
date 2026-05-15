'use client';

// Admin > Cities > [slug] > Listings > [id] — detail view with three panels:
// listing info, snapshot viewer, tag editor + publish.
//
// Next.js 16 notes:
//   - Client component reads route params via useParams() from next/navigation.
//   - The list-snapshots endpoint returns SUMMARIES (sources_cited, item_count
//     etc.) but the spec acknowledges raw_extracted_texts may not be in the
//     summary payload. We render whatever is on the summary object — when
//     raw_extracted_texts is present we expand it, otherwise we fall back to
//     showing the sources_cited URL list. See spec lines about "trust the
//     existing list endpoint".

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import client from '../../../../../../lib/apiClient';
import { useToast } from '../../../../../../components/Toast';
import { useAdminAuth } from '../../../../../../contexts/AdminAuthContext';
import {
  getCityListingDetail,
  getAdminTaxonomy,
  getCityListingSnapshotDetail,
  getListingAnalytics,
} from '../../../../../../api/admin';
import type { MenuSnapshotDetail } from '../../../../../../api/admin';
import type { CityListing, ListingAnalytics, TagTaxonomy } from '../../../../../../types';
import ChartCanvas from '../../../../../../components/shared/ChartCanvas';
import type { ChartData, ChartOptions } from 'chart.js';

// ── Local types ─────────────────────────────────────────────────────

type ListingDetail = CityListing & { latest_snapshot: unknown };

interface SnapshotSource {
  url: string;
  text?: string;
}

interface SnapshotSummary {
  _id: string;
  status?: string;
  source?: string;
  created_at?: string;
  item_count?: number;
  has_tags?: boolean;
  sources_cited?: SnapshotSource[] | string[];
  raw_extracted_texts?: SnapshotSource[];
}

interface EditedTags {
  cuisine_primary: string[];
  veg_status: string | null;
  price_band: string | null;
  vibe_tags: string[];
  meal_contexts: string[];
  service_modes: string[];
  dietary_flags: string[];
  specialty_tags: string[];
}

const EMPTY_TAGS: EditedTags = {
  cuisine_primary: [],
  veg_status: null,
  price_band: null,
  vibe_tags: [],
  meal_contexts: [],
  service_modes: [],
  dietary_flags: [],
  specialty_tags: [],
};

function seedTagsFromListing(listing: ListingDetail | null): EditedTags {
  if (!listing || !listing.tags) return { ...EMPTY_TAGS };
  const t = listing.tags as Record<string, unknown>;
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
  return {
    cuisine_primary: arr(t.cuisine_primary).slice(0, 2),
    veg_status: str(t.veg_status),
    price_band: str(t.price_band),
    vibe_tags: arr(t.vibe_tags),
    meal_contexts: arr(t.meal_contexts),
    service_modes: arr(t.service_modes),
    dietary_flags: arr(t.dietary_flags),
    specialty_tags: arr(t.specialty_tags),
  };
}

function researchBadgeClass(rs: CityListing['research_status']): string {
  switch (rs) {
    case 'pending': return 'chip text-dim';
    case 'in_progress': return 'chip text-yellow-600';
    case 'needs_review': return 'chip text-blue-600';
    case 'complete': return 'chip on';
    case 'research_failed': return 'chip text-red-600';
    case 'no_content_found': return 'chip text-orange-600';
    default: return 'chip';
  }
}

function statusBadgeClass(s: CityListing['status']): string {
  switch (s) {
    case 'active': return 'chip on';
    case 'paused': return 'chip text-dim';
    case 'draft': return 'chip text-yellow-600';
    case 'deleted': return 'chip text-red-600';
    default: return 'chip';
  }
}

function fmtDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN'); } catch { return '—'; }
}

function snapshotStatusBadge(status: string | undefined): string {
  switch (status) {
    case 'complete':
    case 'published':
      return 'chip on';
    case 'failed':
      return 'chip text-red-600';
    case 'pending':
      return 'chip text-dim';
    case 'in_progress':
      return 'chip text-yellow-600';
    default:
      return 'chip';
  }
}

export default function AdminCityListingDetailPage() {
  const params = useParams<{ slug: string; id: string }>();
  const slug = (params?.slug as string) || '';
  const id = (params?.id as string) || '';

  const { showToast } = useToast();
  useAdminAuth();

  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [selectedSnapshotFull, setSelectedSnapshotFull] = useState<MenuSnapshotDetail | null>(null);
  const [taxonomy, setTaxonomy] = useState<TagTaxonomy | null>(null);
  const [editedTags, setEditedTags] = useState<EditedTags>({ ...EMPTY_TAGS });
  const [specialtyInput, setSpecialtyInput] = useState<string>('');

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);
  const [researching, setResearching] = useState<boolean>(false);
  const [publishOk, setPublishOk] = useState<boolean>(false);

  // ── Offers chip input state (Panel 1) ─────────────────────────────
  // Caps mirror the backend validator (PATCH /:slug/listings/:id):
  // max 5 entries, each trimmed and ≤ 80 chars. Seeded from
  // listing.offers on load.
  const OFFERS_MAX = 5;
  const OFFER_MAX_LEN = 80;
  const [offers, setOffers] = useState<string[]>([]);
  const [offerInput, setOfferInput] = useState<string>('');
  const [savingOffers, setSavingOffers] = useState<boolean>(false);

  // ── Performance analytics state ──────────────────────────────────
  // 7-day action counts + funnel percentages + 14-day daily time
  // series, fetched independently from loadAll() so a slow analytics
  // endpoint doesn't block the listing detail. The default window is
  // the backend default (7 days) so we omit the `days` parameter.
  const [analytics, setAnalytics] = useState<ListingAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState<boolean>(true);
  const [analyticsErr, setAnalyticsErr] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    if (!slug || !id) return;
    setLoading(true);
    setError(null);
    try {
      const [listingRes, snapsRes, taxRes] = await Promise.all([
        getCityListingDetail(slug, id),
        client.get<SnapshotSummary[] | { results?: SnapshotSummary[] }>(
          `/api/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(id)}/snapshots`,
        ),
        getAdminTaxonomy(),
      ]);
      setListing(listingRes);
      const snapsData = snapsRes.data;
      const list = Array.isArray(snapsData)
        ? snapsData
        : (snapsData?.results || []);
      // Newest first
      const sorted = [...list].sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
      });
      setSnapshots(sorted);
      // Preselect the newest snapshot if any
      const newest = sorted[0];
      if (newest) setSelectedSnapshotId((prev) => prev || newest._id);
      setTaxonomy(taxRes);
      setEditedTags(seedTagsFromListing(listingRes));
      setOffers(Array.isArray(listingRes?.offers) ? listingRes.offers : []);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setError(er?.response?.data?.error || er?.message || 'Failed to load listing');
    } finally {
      setLoading(false);
    }
  }, [slug, id]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Performance analytics — independent of loadAll() so a slow
  // analytics roll-up doesn't gate the rest of the page.
  useEffect(() => {
    if (!slug || !id) return;
    let cancelled = false;
    setAnalyticsLoading(true);
    setAnalyticsErr(null);
    getListingAnalytics(slug, id)
      .then((res) => { if (!cancelled) setAnalytics(res); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const er = e as { response?: { data?: { error?: string } }; message?: string };
        setAnalyticsErr(er?.response?.data?.error || er?.message || 'Failed to load analytics');
      })
      .finally(() => { if (!cancelled) setAnalyticsLoading(false); });
    return () => { cancelled = true; };
  }, [slug, id]);

  // Fetch full snapshot doc (with raw_extracted_texts) when the selected
  // snapshot changes. The list endpoint only returns summaries, so we hit
  // the detail endpoint to populate the viewer pane.
  useEffect(() => {
    if (!slug || !id || !selectedSnapshotId) {
      setSelectedSnapshotFull(null);
      return;
    }
    let ignored = false;
    setSelectedSnapshotFull(null);
    getCityListingSnapshotDetail(slug, id, selectedSnapshotId)
      .then((full) => {
        if (!ignored) setSelectedSnapshotFull(full);
      })
      .catch(() => {
        if (!ignored) setSelectedSnapshotFull(null);
      });
    return () => { ignored = true; };
  }, [slug, id, selectedSnapshotId]);

  // ── Research trigger ─────────────────────────────────────────────
  const onTriggerResearch = useCallback(async () => {
    if (!slug || !id) return;
    setResearching(true);
    try {
      await client.post(
        `/api/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(id)}/research`,
      );
      showToast('Research triggered', 'success');
      await loadAll();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to trigger research', 'error');
    } finally {
      setResearching(false);
    }
  }, [slug, id, showToast, loadAll]);

  // ── Offers chip helpers (Panel 1) ────────────────────────────────
  // Trim before length-check and dedupe-check so " biryani " and
  // "biryani" don't both land in the array. Reject empty/whitespace-only
  // input silently — pressing Enter in an empty field is a no-op.
  const offersLimitReached = offers.length >= OFFERS_MAX;
  const addOffer = () => {
    const trimmed = offerInput.trim();
    if (!trimmed) return;
    if (trimmed.length > OFFER_MAX_LEN) return;
    if (offers.length >= OFFERS_MAX) return;
    if (offers.includes(trimmed)) {
      setOfferInput('');
      return;
    }
    setOffers((prev) => [...prev, trimmed]);
    setOfferInput('');
  };
  const removeOffer = (val: string) => {
    setOffers((prev) => prev.filter((o) => o !== val));
  };

  const onSaveOffers = useCallback(async () => {
    if (!slug || !id) return;
    setSavingOffers(true);
    try {
      await client.patch(
        `/api/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(id)}`,
        { offers },
      );
      showToast('Offers saved', 'success');
      const fresh = await getCityListingDetail(slug, id);
      setListing(fresh);
      setOffers(Array.isArray(fresh?.offers) ? fresh.offers : []);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to save offers', 'error');
    } finally {
      setSavingOffers(false);
    }
  }, [slug, id, offers, showToast]);

  // ── Tag editing helpers ──────────────────────────────────────────
  const toggleArrayTag = (key: keyof EditedTags, value: string, max?: number) => {
    setEditedTags((prev) => {
      const current = prev[key];
      if (!Array.isArray(current)) return prev;
      const has = current.includes(value);
      if (has) {
        return { ...prev, [key]: current.filter((v) => v !== value) };
      }
      if (typeof max === 'number' && current.length >= max) return prev;
      return { ...prev, [key]: [...current, value] };
    });
  };

  const setScalarTag = (key: 'veg_status' | 'price_band', value: string) => {
    setEditedTags((prev) => ({ ...prev, [key]: value }));
  };

  const addSpecialty = () => {
    const raw = specialtyInput;
    if (!raw.trim()) return;
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    setEditedTags((prev) => {
      const merged = [...prev.specialty_tags];
      parts.forEach((p) => { if (!merged.includes(p)) merged.push(p); });
      return { ...prev, specialty_tags: merged };
    });
    setSpecialtyInput('');
  };

  const removeSpecialty = (tag: string) => {
    setEditedTags((prev) => ({
      ...prev,
      specialty_tags: prev.specialty_tags.filter((t) => t !== tag),
    }));
  };

  // ── Save tags ────────────────────────────────────────────────────
  const onSaveTags = useCallback(async () => {
    if (!slug || !id) return;
    setSaving(true);
    try {
      await client.patch(
        `/api/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(id)}/tags`,
        { tags: editedTags },
      );
      showToast('Tags saved', 'success');
      // Refresh listing so latest tags reflect server state.
      const fresh = await getCityListingDetail(slug, id);
      setListing(fresh);
      setEditedTags(seedTagsFromListing(fresh));
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to save tags', 'error');
    } finally {
      setSaving(false);
    }
  }, [slug, id, editedTags, showToast]);

  // ── Publish snapshot ─────────────────────────────────────────────
  const canPublish = useMemo<boolean>(() => {
    return editedTags.cuisine_primary.length > 0
      && !!editedTags.veg_status
      && !!selectedSnapshotId
      && snapshots.length > 0;
  }, [editedTags.cuisine_primary, editedTags.veg_status, selectedSnapshotId, snapshots.length]);

  const onPublish = useCallback(async () => {
    if (!slug || !id || !selectedSnapshotId) return;
    setPublishing(true);
    setPublishOk(false);
    try {
      await client.post(
        `/api/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(selectedSnapshotId)}/publish`,
      );
      showToast('Snapshot published', 'success');
      setPublishOk(true);
      await loadAll();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to publish', 'error');
    } finally {
      setPublishing(false);
    }
  }, [slug, id, selectedSnapshotId, showToast, loadAll]);

  // ── Render helpers ───────────────────────────────────────────────
  const selectedSnapshot = useMemo<SnapshotSummary | null>(() => {
    if (!selectedSnapshotId) return null;
    return snapshots.find((s) => s._id === selectedSnapshotId) || null;
  }, [snapshots, selectedSnapshotId]);

  const cuisineMax = 2;
  const cuisineLimitReached = editedTags.cuisine_primary.length >= cuisineMax;

  // Pivot time_series into Chart.js-compatible {labels, datasets}.
  // We collect a sorted distinct date list and one dataset per
  // observed action key; missing (date, action) pairs default to 0
  // so each dataset stays the same length as `labels`. The ChartCanvas
  // palette plugin paints datasets — datasets intentionally omit
  // explicit colors.
  const chartData = useMemo<ChartData<'bar'> | null>(() => {
    if (!analytics || !analytics.time_series || analytics.time_series.length === 0) return null;
    const dateSet = new Set<string>();
    const actionSet = new Set<string>();
    for (const pt of analytics.time_series) {
      dateSet.add(pt.date);
      actionSet.add(pt.action);
    }
    const labels = Array.from(dateSet).sort();
    const actions = Array.from(actionSet).sort();
    const datasets = actions.map((action) => {
      const byDate: Record<string, number> = {};
      for (const pt of analytics.time_series) {
        if (pt.action !== action) continue;
        byDate[pt.date] = (byDate[pt.date] || 0) + pt.count;
      }
      return {
        label: action,
        data: labels.map((d) => byDate[d] ?? 0),
      };
    });
    return { labels, datasets };
  }, [analytics]);

  const chartOptions = useMemo<ChartOptions<'bar'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { stacked: true },
      y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
    },
  }), []);

  if (loading) {
    return (
      <div className="p-4">
        <div className="card"><div className="cb text-dim">Loading listing…</div></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="notice warn">
          <div className="notice-ico">⚠️</div>
          <div className="notice-body">
            <p>{error}</p>
            <button type="button" className="btn-g btn-sm" onClick={loadAll}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="p-4">
        <div className="card"><div className="cb text-dim">Listing not found.</div></div>
      </div>
    );
  }

  const canResearchAgain = listing.research_status === 'pending'
    || listing.research_status === 'research_failed'
    || listing.research_status === 'no_content_found';

  return (
    <div id="pg-city-listing-detail" className="space-y-4 p-4">
      <div className="card">
        <div className="ch gap-2.5 flex-wrap">
          <div>
            <h3>{listing.name}</h3>
            <div className="text-xs text-dim">
              <Link
                href={`/admin/cities/${encodeURIComponent(slug)}/listings`}
                className="text-acc hover:underline"
              >← Back to listings</Link>
            </div>
          </div>
        </div>
      </div>

      {publishOk && (
        <div className="notice">
          <div className="notice-ico">✓</div>
          <div className="notice-body">
            <p>Snapshot published successfully.</p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Panel 1 — Listing info */}
        <div className="card">
          <div className="ch gap-2.5 flex-wrap">
            <h3>{listing.name}</h3>
            <span className={statusBadgeClass(listing.status)}>{listing.status}</span>
          </div>
          <div className="cb space-y-3">
            <div>
              <div className="lbl">Area</div>
              <div className="text-sm">{listing.area || '—'}</div>
            </div>
            <div>
              <div className="lbl">Business type</div>
              <div className="text-sm">
                <span className="chip">{listing.business_type === 'cloud_kitchen' ? 'Cloud kitchen' : 'Physical'}</span>
              </div>
            </div>
            <div>
              <div className="lbl">Fulfillment mode</div>
              <div className="text-sm">
                <span className="chip">{listing.fulfillment_mode}</span>
              </div>
            </div>
            <div>
              <div className="lbl">Research status</div>
              <div className="text-sm flex items-center gap-2 flex-wrap">
                <span className={researchBadgeClass(listing.research_status)}>{listing.research_status}</span>
                {listing.research_status === 'in_progress' && (
                  <span className="text-xs text-dim">⏳ working…</span>
                )}
              </div>
              {listing.last_researched_at && (
                <div className="text-xs text-dim mt-1">Last: {fmtDate(listing.last_researched_at)}</div>
              )}
            </div>
            {/* website_url isn't on the CityListing base type but the detail
                endpoint may include it; render conditionally via casting. */}
            {(() => {
              const url = (listing as unknown as { website_url?: string }).website_url;
              if (!url) return null;
              return (
                <div>
                  <div className="lbl">Website</div>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-acc hover:underline break-all"
                  >{url} ↗</a>
                </div>
              );
            })()}
            {/* Offers — chip/tag input. Short promo blurbs surfaced to
                customers via the captain. Backend caps: max 5, ≤ 80 chars. */}
            <div>
              <div className="lbl">Offers</div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className="inp"
                  value={offerInput}
                  maxLength={OFFER_MAX_LEN}
                  placeholder={offersLimitReached ? `Max ${OFFERS_MAX} offers reached` : 'e.g. 20% off on weekdays'}
                  disabled={offersLimitReached}
                  onChange={(e) => setOfferInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addOffer();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn-g btn-sm"
                  onClick={addOffer}
                  disabled={offersLimitReached || !offerInput.trim()}
                >+ Add</button>
              </div>
              <div className="text-xs text-dim mt-1">
                Short offer descriptions shown to customers via captain. Example: 20% off on weekdays
              </div>
              {offers.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {offers.map((o) => (
                    <span key={o} className="chip on flex items-center gap-1">
                      {o}
                      <button
                        type="button"
                        className="text-xs ml-1"
                        onClick={() => removeOffer(o)}
                        aria-label={`Remove ${o}`}
                      >×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="text-xs text-dim mt-1">{offers.length}/{OFFERS_MAX}</div>
            </div>

            <div className="flex items-center gap-2 flex-wrap border-t border-rim pt-3">
              <button
                type="button"
                className="btn-g btn-sm"
                onClick={onSaveOffers}
                disabled={savingOffers}
              >{savingOffers ? 'Saving…' : 'Save'}</button>
              <button
                type="button"
                className="btn-g btn-sm"
                onClick={onTriggerResearch}
                disabled={!canResearchAgain || researching}
              >{researching ? 'Triggering…' : 'Trigger Research'}</button>
            </div>
          </div>
        </div>

        {/* Panel 2 — Snapshot viewer */}
        <div className="card">
          <div className="ch"><h3>Snapshots ({snapshots.length})</h3></div>
          <div className="cb space-y-3">
            {snapshots.length === 0 ? (
              <div className="notice warn">
                <div className="notice-ico">⚠️</div>
                <div className="notice-body">
                  <p>No menu data yet. Trigger research or wait for the research agent to run.</p>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-1 max-h-[300px] overflow-y-auto">
                  {snapshots.map((s) => {
                    const active = s._id === selectedSnapshotId;
                    return (
                      <button
                        type="button"
                        key={s._id}
                        onClick={() => setSelectedSnapshotId(s._id)}
                        className={`w-full text-left p-2 border rounded-md text-xs flex items-center gap-2 flex-wrap ${active ? 'border-acc bg-acc-glow' : 'border-rim hover:border-rim2'}`}
                      >
                        <span className={snapshotStatusBadge(s.status)}>{s.status || 'unknown'}</span>
                        <span className="text-tx">{s.source || 'unknown source'}</span>
                        <span className="text-dim">{fmtDate(s.created_at)}</span>
                        {typeof s.item_count === 'number' && (
                          <span className="text-dim">· {s.item_count} items</span>
                        )}
                        {s.has_tags ? (
                          <span className="text-green-600">· tagged</span>
                        ) : (
                          <span className="text-dim">· untagged</span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {selectedSnapshot && (
                  <div className="space-y-2">
                    <div className="lbl">Selected snapshot details</div>
                    {Array.isArray(selectedSnapshotFull?.raw_extracted_texts) && selectedSnapshotFull.raw_extracted_texts.length > 0 ? (
                      selectedSnapshotFull.raw_extracted_texts.map((src, idx) => (
                        <details key={`${src.url}-${idx}`} className="border border-rim rounded-md p-2">
                          <summary className="cursor-pointer text-xs text-acc break-all">{src.url}</summary>
                          <pre className="max-h-[200px] overflow-y-auto whitespace-pre-wrap text-xs p-2 border border-rim rounded mt-2">
                            {src.text || '(no text extracted)'}
                          </pre>
                        </details>
                      ))
                    ) : Array.isArray(selectedSnapshot.sources_cited) && selectedSnapshot.sources_cited.length > 0 ? (
                      <div className="space-y-1">
                        <div className="text-xs text-dim">
                          Raw text not in summary payload — showing cited sources only.
                        </div>
                        <ul className="space-y-1">
                          {selectedSnapshot.sources_cited.map((s, idx) => {
                            const url = typeof s === 'string' ? s : s.url;
                            return (
                              <li key={`${url}-${idx}`} className="text-xs">
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-acc hover:underline break-all"
                                >{url} ↗</a>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : (
                      <div className="text-xs text-dim">No source details available for this snapshot.</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Panel 3 — Tag editor + publish */}
        <div className="card">
          <div className="ch"><h3>Tag editor</h3></div>
          <div className="cb space-y-4">
            {snapshots.length === 0 && (
              <div className="notice warn">
                <div className="notice-ico">⚠️</div>
                <div className="notice-body">
                  <p>No menu data yet. Trigger research or wait for the research agent to run.</p>
                </div>
              </div>
            )}

            {taxonomy ? (
              <>
                {/* cuisine_primary — max 2 */}
                <div>
                  <div className="lbl">Cuisine (primary) — max 2</div>
                  <div className="flex flex-wrap gap-2">
                    {taxonomy.cuisine_primary.map((c) => {
                      const on = editedTags.cuisine_primary.includes(c);
                      const disabled = !on && cuisineLimitReached;
                      return (
                        <label
                          key={c}
                          className={`chip cursor-pointer ${on ? 'on' : ''} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            disabled={disabled}
                            onChange={() => toggleArrayTag('cuisine_primary', c, cuisineMax)}
                          />
                          {c}
                        </label>
                      );
                    })}
                  </div>
                  <div className="text-xs text-dim mt-1">{editedTags.cuisine_primary.length}/{cuisineMax} selected</div>
                </div>

                {/* veg_status — radio */}
                <div>
                  <div className="lbl">Veg status</div>
                  <div className="flex flex-wrap gap-3">
                    {taxonomy.veg_status_options.map((opt) => (
                      <label key={opt} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="veg_status"
                          value={opt}
                          checked={editedTags.veg_status === opt}
                          onChange={() => setScalarTag('veg_status', opt)}
                        />
                        {opt}
                      </label>
                    ))}
                  </div>
                </div>

                {/* price_band — radio */}
                <div>
                  <div className="lbl">Price band</div>
                  <div className="flex flex-wrap gap-3">
                    {taxonomy.price_bands.map((band) => (
                      <label key={band.key} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="price_band"
                          value={band.key}
                          checked={editedTags.price_band === band.key}
                          onChange={() => setScalarTag('price_band', band.key)}
                        />
                        {band.label}
                      </label>
                    ))}
                  </div>
                </div>

                {/* vibe_tags */}
                <div>
                  <div className="lbl">Vibe tags</div>
                  <div className="flex flex-wrap gap-2">
                    {taxonomy.vibe_tags.map((v) => {
                      const on = editedTags.vibe_tags.includes(v);
                      return (
                        <label key={v} className={`chip cursor-pointer ${on ? 'on' : ''}`}>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            onChange={() => toggleArrayTag('vibe_tags', v)}
                          />
                          {v}
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* meal_contexts */}
                <div>
                  <div className="lbl">Meal contexts</div>
                  <div className="flex flex-wrap gap-2">
                    {taxonomy.meal_contexts.map((m) => {
                      const on = editedTags.meal_contexts.includes(m);
                      return (
                        <label key={m} className={`chip cursor-pointer ${on ? 'on' : ''}`}>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            onChange={() => toggleArrayTag('meal_contexts', m)}
                          />
                          {m}
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* service_modes */}
                <div>
                  <div className="lbl">Service modes</div>
                  <div className="flex flex-wrap gap-2">
                    {taxonomy.service_modes.map((s) => {
                      const on = editedTags.service_modes.includes(s);
                      return (
                        <label key={s} className={`chip cursor-pointer ${on ? 'on' : ''}`}>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            onChange={() => toggleArrayTag('service_modes', s)}
                          />
                          {s}
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* dietary_flags */}
                <div>
                  <div className="lbl">Dietary flags</div>
                  <div className="flex flex-wrap gap-2">
                    {taxonomy.dietary_flags.map((d) => {
                      const on = editedTags.dietary_flags.includes(d);
                      return (
                        <label key={d} className={`chip cursor-pointer ${on ? 'on' : ''}`}>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            onChange={() => toggleArrayTag('dietary_flags', d)}
                          />
                          {d}
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* specialty_tags — free text */}
                <div>
                  <div className="lbl">Specialty tags (free text)</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      className="inp"
                      value={specialtyInput}
                      placeholder="e.g. famous-biryani (comma-separated supported)"
                      onChange={(e) => setSpecialtyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addSpecialty();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn-g btn-sm"
                      onClick={addSpecialty}
                    >+ Add</button>
                  </div>
                  {editedTags.specialty_tags.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {editedTags.specialty_tags.map((t) => (
                        <span key={t} className="chip on flex items-center gap-1">
                          {t}
                          <button
                            type="button"
                            className="text-xs ml-1"
                            onClick={() => removeSpecialty(t)}
                            aria-label={`Remove ${t}`}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-dim text-sm">Taxonomy not loaded.</div>
            )}

            <div className="flex items-center gap-2 flex-wrap border-t border-rim pt-3">
              <button
                type="button"
                className="btn-g btn-sm"
                onClick={onSaveTags}
                disabled={saving}
              >{saving ? 'Saving…' : 'Save Tags'}</button>
              <button
                type="button"
                className="btn-p btn-sm"
                onClick={onPublish}
                disabled={!canPublish || publishing}
              >{publishing ? 'Publishing…' : 'Publish Snapshot'}</button>
            </div>
            {!canPublish && snapshots.length > 0 && (
              <div className="text-xs text-dim">
                Need at least one cuisine, a veg status, and a selected snapshot to publish.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Panel 4 — Performance analytics. 7-day action counts, three
          funnel percentages, and a 14-day stacked bar chart pivoted
          from the daily time series. Lives outside the 3-panel grid
          so the chart has room to breathe. */}
      <div className="card">
        <div className="ch"><h3>Performance — last 7 days</h3></div>
        <div className="cb space-y-4">
          {analyticsLoading ? (
            <div className="text-dim text-sm">Loading…</div>
          ) : analyticsErr ? (
            <div className="notice warn">
              <div className="notice-ico">⚠️</div>
              <div className="notice-body">
                <p>Could not load analytics.</p>
              </div>
            </div>
          ) : !analytics ? (
            <div className="text-dim text-sm">No analytics data.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="stat">
                  <div className="stat-l">Impressions</div>
                  <div className="stat-v">{analytics.actions.listing_card_shown}</div>
                </div>
                <div className="stat">
                  <div className="stat-l">Menu views</div>
                  <div className="stat-v">{analytics.actions.menu_viewed}</div>
                </div>
                <div className="stat">
                  <div className="stat-l">Notify taps</div>
                  <div className="stat-v">{analytics.actions.tapped_notify_me}</div>
                </div>
                <div className="stat">
                  <div className="stat-l">Orders</div>
                  <div className="stat-v">{analytics.actions.gbref_order_attributed}</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="stat">
                  <div className="stat-l">Impression → View</div>
                  <div className="stat-v">{(analytics.funnel.impression_to_view * 100).toFixed(1)}%</div>
                </div>
                <div className="stat">
                  <div className="stat-l">View → Action</div>
                  <div className="stat-v">{(analytics.funnel.view_to_action * 100).toFixed(1)}%</div>
                </div>
                <div className="stat">
                  <div className="stat-l">Action → Conversion</div>
                  <div className="stat-v">{(analytics.funnel.action_to_conversion * 100).toFixed(1)}%</div>
                </div>
              </div>

              <div>
                <div className="lbl">Daily activity (14 days)</div>
                {chartData ? (
                  <ChartCanvas
                    type="bar"
                    data={chartData}
                    options={chartOptions}
                    height={220}
                  />
                ) : (
                  <div className="text-dim text-sm">No daily activity recorded yet.</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
