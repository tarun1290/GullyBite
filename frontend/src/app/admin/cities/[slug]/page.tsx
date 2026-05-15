'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import client from '../../../../lib/apiClient';
import { useToast } from '../../../../components/Toast';
import {
  getCaptainPersona,
  getCityAnalytics,
  getCityDetail,
  getCityInterestLeaderboard,
  getCityListings,
  refreshCityWabaStatus,
  updateCaptainPersona,
} from '../../../../api/admin';
import type {
  CityAnalytics,
  CityDoc,
  CityInterestLeaderboard,
  CityWabaMeta,
} from '../../../../types';

interface PageState {
  loading: boolean;
  err: string | null;
  city: CityDoc | null;
  total: number;
  active: number;
  needsReview: number;
  researchFailed: number;
}

const INITIAL: PageState = {
  loading: true,
  err: null,
  city: null,
  total: 0,
  active: 0,
  needsReview: 0,
  researchFailed: 0,
};

// Compact relative-time formatter for the "Last checked" WABA line.
// Returns '—' for null/undefined; otherwise bucketed Just-now / seconds
// / minutes / hours / days strings. Intentionally library-free.
function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return 'Just now';
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return min === 1 ? '1 minute ago' : `${min} minutes ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr === 1 ? '1 hour ago' : `${hr} hours ago`;
  const day = Math.floor(hr / 24);
  return day === 1 ? '1 day ago' : `${day} days ago`;
}

function statusClass(status: CityDoc['status']): string {
  switch (status) {
    case 'active':
      return 'chip on';
    case 'setup':
      return 'chip text-yellow-600';
    case 'paused':
      return 'chip text-dim';
    case 'deleted':
      return 'chip text-red-600';
    default:
      return 'chip';
  }
}

export default function AdminCityDetailPage() {
  // Next.js 16 App Router: `useParams` from next/navigation returns
  // the matched dynamic segments. Since this is a client component
  // marked with 'use client', we use the hook form rather than the
  // server-component params Promise.
  const params = useParams<{ slug: string }>();
  const slug = params?.slug as string;

  const { showToast } = useToast();
  const [state, setState] = useState<PageState>(INITIAL);
  const [researching, setResearching] = useState<boolean>(false);

  // WABA-status refresh — clicking the button hits Meta and writes the
  // freshly-fetched projection to the city doc. `wabaOverride` lets the
  // UI show the freshly-fetched values immediately, without a full reload
  // of the city detail. Falls back to `city.meta` when null.
  const [refreshingWaba, setRefreshingWaba] = useState<boolean>(false);
  const [wabaOverride, setWabaOverride] = useState<CityWabaMeta | null>(null);

  // ── Captain analytics state ─────────────────────────────────────
  // Section 1: 7-day rollup of sessions + signal totals. Window is
  // fixed at 7 (backend default) so we don't expose a toggle here.
  // Section 2: interest leaderboard, with a 7d / 30d toggle that
  // refetches on change.
  const [analytics, setAnalytics] = useState<CityAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState<boolean>(true);
  const [analyticsErr, setAnalyticsErr] = useState<string | null>(null);

  const [daysWindow, setDaysWindow] = useState<7 | 30>(7);
  const [leaderboard, setLeaderboard] = useState<CityInterestLeaderboard | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState<boolean>(true);
  const [leaderboardErr, setLeaderboardErr] = useState<string | null>(null);

  // ── Captain persona editor ──────────────────────────────────────
  // Collapsed by default; the GET request is deferred until the user
  // first expands the section, so cities that never touch the persona
  // pay zero network cost on page load. Template is stored unsubstituted
  // (contains the raw {city_name} placeholder).
  const [personaOpen, setPersonaOpen] = useState<boolean>(false);
  const [personaLoaded, setPersonaLoaded] = useState<boolean>(false);
  const [personaLoading, setPersonaLoading] = useState<boolean>(false);
  const [personaSaving, setPersonaSaving] = useState<boolean>(false);
  const [personaValue, setPersonaValue] = useState<string>('');
  const [personaErr, setPersonaErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!slug) return;
    setState((p) => ({ ...p, loading: true, err: null }));
    try {
      const [city, listAll, listActive, listNeedsReview, listFailed] = await Promise.all([
        getCityDetail(slug),
        getCityListings(slug, { limit: 1 }),
        getCityListings(slug, { status: 'active', limit: 1 }),
        getCityListings(slug, { research_status: 'needs_review', limit: 1 }),
        getCityListings(slug, { research_status: 'research_failed', limit: 1 }),
      ]);
      setState({
        loading: false,
        err: null,
        city,
        total: listAll.total,
        active: listActive.total,
        needsReview: listNeedsReview.total,
        researchFailed: listFailed.total,
      });
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setState((p) => ({
        ...p,
        loading: false,
        err: er?.response?.data?.error || er?.message || 'Failed to load city',
      }));
    }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  // Captain activity — fixed 7-day window, fetched once per slug.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setAnalyticsLoading(true);
    setAnalyticsErr(null);
    getCityAnalytics(slug)
      .then((res) => { if (!cancelled) setAnalytics(res); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const er = e as { response?: { data?: { error?: string } }; message?: string };
        setAnalyticsErr(er?.response?.data?.error || er?.message || 'Failed to load analytics');
      })
      .finally(() => { if (!cancelled) setAnalyticsLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  // Interest leaderboard — refetches when the user flips 7d ↔ 30d.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setLeaderboardLoading(true);
    setLeaderboardErr(null);
    getCityInterestLeaderboard(slug, daysWindow)
      .then((res) => { if (!cancelled) setLeaderboard(res); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const er = e as { response?: { data?: { error?: string } }; message?: string };
        setLeaderboardErr(er?.response?.data?.error || er?.message || 'Failed to load leaderboard');
      })
      .finally(() => { if (!cancelled) setLeaderboardLoading(false); });
    return () => { cancelled = true; };
  }, [slug, daysWindow]);

  const onRefreshWaba = useCallback(async () => {
    if (!slug) return;
    setRefreshingWaba(true);
    try {
      const next = await refreshCityWabaStatus(slug);
      setWabaOverride(next);
      showToast('WABA status refreshed', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Refresh failed', 'error');
    } finally {
      setRefreshingWaba(false);
    }
  }, [slug, showToast]);

  // Toggle the persona editor. On the first expand we fetch the
  // template; subsequent expands reuse the cached value in component
  // state. Errors surface via the personaErr banner inside the panel
  // rather than a toast — the editor is still usable with the default
  // copy if the GET fails.
  const onTogglePersona = useCallback(async () => {
    const next = !personaOpen;
    setPersonaOpen(next);
    if (!next || personaLoaded || personaLoading) return;
    setPersonaLoading(true);
    setPersonaErr(null);
    try {
      const res = await getCaptainPersona();
      setPersonaValue(res.persona ?? '');
      setPersonaLoaded(true);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setPersonaErr(e?.response?.data?.error || e?.message || 'Failed to load persona');
    } finally {
      setPersonaLoading(false);
    }
  }, [personaOpen, personaLoaded, personaLoading]);

  const onSavePersona = useCallback(async () => {
    if (personaSaving) return;
    const trimmed = personaValue.trim();
    if (trimmed.length === 0) {
      showToast('Persona cannot be empty', 'error');
      return;
    }
    setPersonaSaving(true);
    try {
      const res = await updateCaptainPersona(personaValue);
      setPersonaValue(res.persona ?? personaValue);
      showToast('Captain persona saved', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to save persona', 'error');
    } finally {
      setPersonaSaving(false);
    }
  }, [personaValue, personaSaving, showToast]);

  const onResearchAll = useCallback(async () => {
    if (!slug) return;
    const ok = typeof window !== 'undefined'
      ? window.confirm('Trigger research for ALL listings in this city? This may take a while.')
      : true;
    if (!ok) return;
    setResearching(true);
    try {
      await client.post(`/api/admin/cities/${encodeURIComponent(slug)}/research-all`);
      showToast('Research queued for all listings', 'success');
      await load();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to trigger research', 'error');
    } finally {
      setResearching(false);
    }
  }, [slug, showToast, load]);

  const city = state.city;
  const wabaIdLine = useMemo<string | null>(() => {
    if (!city) return null;
    return city.waba_id ? city.waba_id : null;
  }, [city]);

  return (
    <div id="pg-city-detail" className="space-y-4 p-4">
      {state.loading ? (
        <div className="card">
          <div className="cb text-dim">Loading city…</div>
        </div>
      ) : state.err ? (
        <div className="card">
          <div className="cb">
            <div className="notice warn">
              <div className="notice-ico">⚠️</div>
              <div className="notice-body">
                <p>{state.err}</p>
                <button type="button" className="btn-g btn-sm" onClick={load}>Retry</button>
              </div>
            </div>
          </div>
        </div>
      ) : !city ? (
        <div className="card"><div className="cb text-dim">City not found.</div></div>
      ) : (
        <>
          <div className="card">
            <div className="ch gap-2.5 flex-wrap">
              <div>
                <h3>{city.name}</h3>
                <div className="text-xs text-dim">{city.display_name || city.slug}</div>
              </div>
              <span className={`${statusClass(city.status)} ml-2`}>{city.status}</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  className="btn-g btn-sm"
                  onClick={load}
                  disabled={state.loading}
                >↻ Refresh</button>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="ch"><h3>WABA + Areas</h3></div>
            <div className="cb space-y-3">
              <div>
                <div className="lbl">Phone Number ID</div>
                <div className="text-sm">{city.phone_number_id || '—'}</div>
              </div>
              {wabaIdLine && (
                <div>
                  <div className="lbl">WABA ID</div>
                  <div className="text-sm">{wabaIdLine}</div>
                </div>
              )}
              <div>
                <div className="lbl">Quality rating</div>
                <div className="flex items-center gap-2">
                  <div className="text-sm">
                    {wabaOverride?.quality_rating ?? city?.meta?.quality_rating ?? '—'}
                  </div>
                  <button
                    type="button"
                    className="btn-g btn-sm"
                    onClick={onRefreshWaba}
                    disabled={refreshingWaba}
                  >{refreshingWaba ? 'Refreshing…' : 'Refresh'}</button>
                </div>
                <div className="text-xs text-dim mt-1">
                  Last checked: {fmtRelative(wabaOverride?.refreshed_at || city?.meta?.refreshed_at)}
                </div>
              </div>
              <div>
                <div className="lbl">Areas</div>
                {city.areas.length === 0 ? (
                  <div className="text-dim text-xs">No areas configured</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {city.areas.map((a) => (
                      <span key={a} className="chip on">{a}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="ch"><h3>Listing stats</h3></div>
            <div className="cb">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="stat">
                  <div className="stat-l">Listings</div>
                  <div className="stat-v">{state.total}</div>
                </div>
                <div className="stat">
                  <div className="stat-l">Active</div>
                  <div className="stat-v">{state.active}</div>
                </div>
                <div className="stat">
                  <div className="stat-l">Needs review</div>
                  <div className="stat-v">{state.needsReview}</div>
                </div>
                <div className="stat">
                  <div className="stat-l">Research failed</div>
                  <div className="stat-v">{state.researchFailed}</div>
                </div>
              </div>
            </div>
          </div>

          {state.researchFailed > 0 && (
            <div className="notice warn">
              <div className="notice-ico">⚠️</div>
              <div className="notice-body">
                <p>{state.researchFailed} listings failed research. Retry from the listings page.</p>
              </div>
            </div>
          )}

          {/* Captain activity — 7-day rollup. Pulled from
              GET /api/admin/cities/:slug/analytics with the backend
              default window. */}
          <div className="card">
            <div className="ch"><h3>Captain activity — last 7 days</h3></div>
            <div className="cb">
              {analyticsLoading ? (
                <div className="text-dim text-sm">Loading…</div>
              ) : analyticsErr ? (
                <div className="notice warn">
                  <div className="notice-ico">⚠️</div>
                  <div className="notice-body">
                    <p>Could not load analytics.</p>
                  </div>
                </div>
              ) : analytics ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="stat">
                    <div className="stat-l">Sessions this week</div>
                    <div className="stat-v">{analytics.sessions.new_in_window}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-l">Menu views</div>
                    <div className="stat-v">{analytics.signals.menu_viewed ?? 0}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-l">Notify-me taps</div>
                    <div className="stat-v">{analytics.signals.tapped_notify_me ?? 0}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-l">Order taps</div>
                    <div className="stat-v">{analytics.signals.tapped_order_handoff ?? 0}</div>
                  </div>
                </div>
              ) : (
                <div className="text-dim text-sm">No analytics data.</div>
              )}
            </div>
          </div>

          {/* Interest leaderboard — top 10 listings by weighted action
              score over the selected window. Renders an inline
              "X waiting" badge for listings with unfulfilled notify-me
              intent to surface warm sales leads. */}
          <div className="card">
            <div className="ch gap-2.5 flex-wrap">
              <h3>Interest leaderboard</h3>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  className={daysWindow === 7 ? 'chip on' : 'chip'}
                  onClick={() => setDaysWindow(7)}
                >7d</button>
                <button
                  type="button"
                  className={daysWindow === 30 ? 'chip on' : 'chip'}
                  onClick={() => setDaysWindow(30)}
                >30d</button>
              </div>
            </div>
            <div className="cb">
              {leaderboardLoading ? (
                <div className="text-dim text-sm">Loading…</div>
              ) : leaderboardErr ? (
                <div className="notice warn">
                  <div className="notice-ico">⚠️</div>
                  <div className="notice-body">
                    <p>Could not load analytics.</p>
                  </div>
                </div>
              ) : !leaderboard || leaderboard.results.length === 0 ? (
                <div className="text-dim text-sm">No interest data yet for this window.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-dim">
                        <th className="text-left py-2 pr-3">Rank</th>
                        <th className="text-left py-2 pr-3">Listing</th>
                        <th className="text-left py-2 pr-3">Area</th>
                        <th className="text-left py-2 pr-3">Interest</th>
                        <th className="text-left py-2">Notify-me</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboard.results.slice(0, 10).map((row) => (
                        <tr key={row.listing_id} className="border-t border-rim">
                          <td className="py-2 pr-3">{row.rank}</td>
                          <td className="py-2 pr-3">
                            <Link
                              href={`/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(row.listing_id)}`}
                              className="text-acc hover:underline"
                            >{row.name}</Link>
                          </td>
                          <td className="py-2 pr-3">{row.area || '—'}</td>
                          <td className="py-2 pr-3">{row.interest_score}</td>
                          <td className="py-2">
                            <span className="inline-flex items-center gap-2 flex-wrap">
                              <span>{row.tapped_notify_me}</span>
                              {row.unfulfilled_notify_count > 0 && (
                                <span className="chip on text-xs">{row.unfulfilled_notify_count} waiting</span>
                              )}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="ch"><h3>Actions</h3></div>
            <div className="cb flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-g"
                onClick={onResearchAll}
                disabled={researching}
              >{researching ? 'Triggering…' : 'Research All'}</button>
              <Link
                href={`/admin/cities/${encodeURIComponent(slug)}/listings`}
                className="btn-g"
              >View Listings</Link>
            </div>
          </div>

          {/* Captain persona — collapsible LLM system prompt editor.
              Single platform-wide template; the {city_name} placeholder
              is substituted at runtime by captainHandler. Mutations
              invalidate the `captain:persona` Redis cache server-side. */}
          <div className="card">
            <button
              type="button"
              className="ch w-full text-left gap-2.5 flex-wrap"
              onClick={onTogglePersona}
              aria-expanded={personaOpen}
            >
              <span className="text-dim text-sm" aria-hidden="true">{personaOpen ? '▾' : '▸'}</span>
              <h3>Captain Persona</h3>
              {personaLoading && <span className="text-dim text-xs ml-2">Loading…</span>}
            </button>
            {personaOpen && (
              <div className="cb space-y-3">
                {personaErr ? (
                  <div className="notice warn">
                    <div className="notice-ico">⚠️</div>
                    <div className="notice-body">
                      <p>{personaErr}</p>
                    </div>
                  </div>
                ) : null}
                <textarea
                  className="w-full font-mono text-xs border border-rim rounded p-2 bg-transparent"
                  rows={8}
                  value={personaValue}
                  onChange={(e) => setPersonaValue(e.target.value)}
                  disabled={personaLoading || personaSaving}
                  spellCheck={false}
                />
                <div className="text-xs text-dim">
                  Use {'{city_name}'} as a placeholder — it is replaced with the actual city name at runtime.
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-g btn-sm"
                    onClick={onSavePersona}
                    disabled={personaLoading || personaSaving}
                  >{personaSaving ? 'Saving…' : 'Save'}</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
