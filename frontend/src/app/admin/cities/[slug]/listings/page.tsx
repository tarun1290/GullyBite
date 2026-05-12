'use client';

// Admin > Cities > [slug] > Listings — list view + filter bar + create modal.
//
// Next.js 16 specifics:
//   - Client component uses useParams() from next/navigation (NOT the server
//     `params: Promise<>` form that App Router 16 uses in server components).
//   - Toast API in this codebase is showToast(message, type), not toast.x().

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import client from '../../../../../lib/apiClient';
import { useToast } from '../../../../../components/Toast';
import { useAdminAuth } from '../../../../../contexts/AdminAuthContext';
import {
  exportLeaderboard,
  getCityDetail,
  getCityListings,
} from '../../../../../api/admin';
import type { CityDoc, CityListing } from '../../../../../types';

type ResearchStatus = CityListing['research_status'];

interface Filters {
  status: string;
  research_status: string;
  business_type: string;
  area: string;
}

interface CreateForm {
  name: string;
  area: string;
  business_type: 'physical' | 'cloud_kitchen';
  description: string;
  website_url: string;
  phone_number: string;
  delivery_zones: string;
}

const INITIAL_FILTERS: Filters = {
  status: '',
  research_status: '',
  business_type: '',
  area: '',
};

const INITIAL_CREATE: CreateForm = {
  name: '',
  area: '',
  business_type: 'physical',
  description: '',
  website_url: '',
  phone_number: '',
  delivery_zones: '',
};

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'deleted', label: 'Deleted' },
];

const RESEARCH_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All research' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'complete', label: 'Complete' },
  { value: 'research_failed', label: 'Failed' },
  { value: 'no_content_found', label: 'No content found' },
];

const BUSINESS_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'physical', label: 'Physical' },
  { value: 'cloud_kitchen', label: 'Cloud kitchen' },
];

function researchBadgeClass(rs: ResearchStatus): string {
  switch (rs) {
    case 'pending':
      return 'chip text-dim';
    case 'in_progress':
      return 'chip text-yellow-600';
    case 'needs_review':
      return 'chip text-blue-600';
    case 'complete':
      return 'chip on';
    case 'research_failed':
      return 'chip text-red-600';
    case 'no_content_found':
      return 'chip text-orange-600';
    default:
      return 'chip';
  }
}

function statusBadgeClass(s: CityListing['status']): string {
  switch (s) {
    case 'active':
      return 'chip on';
    case 'paused':
      return 'chip text-dim';
    case 'draft':
      return 'chip text-yellow-600';
    case 'deleted':
      return 'chip text-red-600';
    default:
      return 'chip';
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN'); } catch { return '—'; }
}

const TH_CLS = 'py-2.5 px-3 text-left text-xs text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2.5 px-3 align-top';

export default function AdminCityListingsPage() {
  const params = useParams<{ slug: string }>();
  const slug = (params?.slug as string) || '';

  const { showToast } = useToast();
  // Touch useAdminAuth so the page participates in RBAC gating, even though
  // we don't read any specific field here — the AdminLayoutClient handles
  // redirect-on-unauth. (Imported per spec.)
  useAdminAuth();

  const [city, setCity] = useState<CityDoc | null>(null);
  const [listings, setListings] = useState<CityListing[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [limit] = useState<number>(50);
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [creating, setCreating] = useState<boolean>(false);
  const [createForm, setCreateForm] = useState<CreateForm>(INITIAL_CREATE);
  const [createBusy, setCreateBusy] = useState<boolean>(false);
  const [bulkBusy, setBulkBusy] = useState<boolean>(false);
  const [exporting, setExporting] = useState<boolean>(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  // Initial mount: fetch city + first page of listings together.
  const loadAll = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const [cityRes, listRes] = await Promise.all([
        getCityDetail(slug),
        getCityListings(slug, { page, limit }),
      ]);
      setCity(cityRes);
      setListings(listRes.results || []);
      setTotal(listRes.total || 0);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setError(er?.response?.data?.error || er?.message || 'Failed to load listings');
    } finally {
      setLoading(false);
    }
  // page/limit are needed for first fetch; filters intentionally left out
  // because the filter-triggered effect below handles them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Refetch listings when filters or page change (but skip the initial mount
  // since loadAll already covers it).
  const refetchListings = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const queryParams: Record<string, unknown> = { page, limit };
      if (filters.status) queryParams.status = filters.status;
      if (filters.research_status) queryParams.research_status = filters.research_status;
      if (filters.business_type) queryParams.business_type = filters.business_type;
      if (filters.area) queryParams.area = filters.area;
      const listRes = await getCityListings(slug, queryParams);
      setListings(listRes.results || []);
      setTotal(listRes.total || 0);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setError(er?.response?.data?.error || er?.message || 'Failed to load listings');
    } finally {
      setLoading(false);
    }
  }, [slug, page, limit, filters]);

  // First render runs both loadAll() and refetchListings(); that's OK — the
  // second one just refines/overwrites the first. Acceptable tradeoff to
  // keep the refetch deps clean.
  useEffect(() => {
    if (!city) return; // wait until city loaded once
    refetchListings();
  // city only used as a gate, not a dependency we want to refire on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page]);

  const onFilterChange = (key: keyof Filters, value: string) => {
    setPage(1);
    setFilters((p) => ({ ...p, [key]: value }));
  };

  const onExportLeads = useCallback(async () => {
    if (!slug) return;
    setExporting(true);
    try {
      await exportLeaderboard(slug);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  }, [slug, showToast]);

  const onBulkResearch = useCallback(async () => {
    if (!slug) return;
    const ok = typeof window !== 'undefined'
      ? window.confirm('Trigger research for ALL listings matching the current view? This may take a while.')
      : true;
    if (!ok) return;
    setBulkBusy(true);
    try {
      const { data } = await client.post<{ enqueued?: number; skipped?: number }>(
        `/api/admin/cities/${encodeURIComponent(slug)}/research-all`,
      );
      const enq = data?.enqueued ?? 0;
      const skp = data?.skipped ?? 0;
      showToast(`${enq} enqueued, ${skp} skipped`, 'success');
      await refetchListings();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Bulk research failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  }, [slug, showToast, refetchListings]);

  const onRowResearch = useCallback(async (listingId: string) => {
    if (!slug) return;
    setRowBusy(listingId);
    try {
      await client.post(
        `/api/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(listingId)}/research`,
      );
      showToast('Research triggered', 'success');
      await refetchListings();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to trigger research', 'error');
    } finally {
      setRowBusy(null);
    }
  }, [slug, showToast, refetchListings]);

  const openCreate = () => {
    setCreateForm({ ...INITIAL_CREATE, area: city?.areas?.[0] || '' });
    setCreating(true);
  };
  const closeCreate = () => {
    setCreating(false);
    setCreateForm(INITIAL_CREATE);
  };

  const onCreateSubmit = useCallback(async () => {
    if (!slug) return;
    // Validation
    if (!createForm.name.trim()) {
      showToast('Name is required', 'error');
      return;
    }
    if (!createForm.area.trim()) {
      showToast('Area is required', 'error');
      return;
    }
    if (!createForm.business_type) {
      showToast('Business type is required', 'error');
      return;
    }
    let deliveryZones: string[] = [];
    if (createForm.business_type === 'cloud_kitchen') {
      deliveryZones = createForm.delivery_zones
        .split('\n')
        .map((z) => z.trim())
        .filter(Boolean);
      if (deliveryZones.length === 0) {
        showToast('At least one delivery zone is required for cloud kitchens', 'error');
        return;
      }
    }
    setCreateBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: createForm.name.trim(),
        area: createForm.area.trim(),
        business_type: createForm.business_type,
      };
      if (createForm.description.trim()) body.description = createForm.description.trim();
      if (createForm.website_url.trim()) body.website_url = createForm.website_url.trim();
      if (createForm.phone_number.trim()) body.phone_number = createForm.phone_number.trim();
      if (deliveryZones.length > 0) body.delivery_zones = deliveryZones;

      await client.post(
        `/api/admin/cities/${encodeURIComponent(slug)}/listings`,
        body,
      );
      showToast('Listing created', 'success');
      closeCreate();
      setFilters(INITIAL_FILTERS);
      setPage(1);
      await refetchListings();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to create listing', 'error');
    } finally {
      setCreateBusy(false);
    }
  }, [slug, createForm, showToast, refetchListings]);

  const totalPages = useMemo<number>(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);
  const prevDisabled = page === 1 || loading;
  const nextDisabled = page * limit >= total || loading;

  const areaOptions: { value: string; label: string }[] = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: 'All areas' }];
    (city?.areas || []).forEach((a) => opts.push({ value: a, label: a }));
    return opts;
  }, [city]);

  return (
    <div id="pg-city-listings" className="space-y-4 p-4">
      <div className="card">
        <div className="ch gap-2.5 flex-wrap">
          <div>
            <h3>{city ? `Listings — ${city.name}` : 'Listings'}</h3>
            <div className="text-xs text-dim">
              <Link
                href={`/admin/cities/${encodeURIComponent(slug)}`}
                className="text-acc hover:underline"
              >← Back to city</Link>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="btn-p"
              onClick={openCreate}
            >+ Create Listing</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cb">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <div className="lbl">Status</div>
              <select
                className="inp"
                value={filters.status}
                onChange={(e) => onFilterChange('status', e.target.value)}
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="lbl">Research status</div>
              <select
                className="inp"
                value={filters.research_status}
                onChange={(e) => onFilterChange('research_status', e.target.value)}
              >
                {RESEARCH_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="lbl">Business type</div>
              <select
                className="inp"
                value={filters.business_type}
                onChange={(e) => onFilterChange('business_type', e.target.value)}
              >
                {BUSINESS_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="lbl">Area</div>
              <select
                className="inp"
                value={filters.area}
                onChange={(e) => onFilterChange('area', e.target.value)}
              >
                {areaOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-2">
              <button
                type="button"
                className="btn-g w-full"
                onClick={onBulkResearch}
                disabled={bulkBusy || loading}
              >{bulkBusy ? 'Working…' : 'Bulk Research All'}</button>
              <button
                type="button"
                className="btn-g w-full"
                onClick={onExportLeads}
                disabled={exporting}
              >{exporting ? 'Exporting…' : 'Export Leads CSV'}</button>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="notice warn">
          <div className="notice-ico">⚠️</div>
          <div className="notice-body">
            <p>{error}</p>
            <button type="button" className="btn-g btn-sm" onClick={refetchListings}>Retry</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="ch">
          <h3>Listings ({total})</h3>
          <span className="text-xs text-dim ml-auto">
            Page {page} / {totalPages}
          </span>
        </div>
        <div className="cb overflow-x-auto p-0">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-ink border-b border-rim">
                <th className={TH_CLS}>Name</th>
                <th className={TH_CLS}>Area</th>
                <th className={TH_CLS}>Business</th>
                <th className={TH_CLS}>Status</th>
                <th className={TH_CLS}>Research</th>
                <th className={TH_CLS}>Fulfillment</th>
                <th className={TH_CLS}>Last researched</th>
                <th className={TH_CLS}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-dim">Loading…</td>
                </tr>
              ) : listings.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-dim">No listings match these filters.</td>
                </tr>
              ) : (
                listings.map((l) => {
                  const canResearch = l.research_status === 'pending'
                    || l.research_status === 'research_failed'
                    || l.research_status === 'no_content_found';
                  const busy = rowBusy === l._id;
                  return (
                    <tr key={l._id} className="border-b border-rim">
                      <td className={TD_CLS}>
                        <strong>{l.name}</strong>
                        <div className="text-xs text-dim">{l.slug}</div>
                      </td>
                      <td className={TD_CLS}>{l.area || '—'}</td>
                      <td className={TD_CLS}>
                        <span className="chip">{l.business_type === 'cloud_kitchen' ? 'Cloud kitchen' : 'Physical'}</span>
                      </td>
                      <td className={TD_CLS}>
                        <span className={statusBadgeClass(l.status)}>{l.status}</span>
                      </td>
                      <td className={TD_CLS}>
                        <span className={researchBadgeClass(l.research_status)}>{l.research_status}</span>
                      </td>
                      <td className={TD_CLS}>
                        <span className="chip">{l.fulfillment_mode}</span>
                      </td>
                      <td className={TD_CLS}>{fmtDate(l.last_researched_at)}</td>
                      <td className={TD_CLS}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            href={`/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(l._id)}`}
                            className="btn-g btn-sm text-xs"
                          >View</Link>
                          <button
                            type="button"
                            className="btn-g btn-sm text-xs"
                            disabled={!canResearch || busy}
                            onClick={() => onRowResearch(l._id)}
                          >{busy ? 'Working…' : 'Research'}</button>
                        </div>
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

      {creating && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-ink2 border border-rim rounded-md w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="ch">
              <h3>Create Listing</h3>
              <button
                type="button"
                className="btn-g btn-sm ml-auto"
                onClick={closeCreate}
                disabled={createBusy}
              >Close</button>
            </div>
            <div className="cb space-y-3">
              <div>
                <div className="lbl">Name *</div>
                <input
                  type="text"
                  className="inp"
                  value={createForm.name}
                  onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Paradise Biryani"
                />
              </div>

              <div>
                <div className="lbl">Area *</div>
                <select
                  className="inp"
                  value={createForm.area}
                  onChange={(e) => setCreateForm((p) => ({ ...p, area: e.target.value }))}
                >
                  <option value="">Select an area…</option>
                  {(city?.areas || []).map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>

              <div>
                <div className="lbl">Business type *</div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="business_type"
                      value="physical"
                      checked={createForm.business_type === 'physical'}
                      onChange={() => setCreateForm((p) => ({ ...p, business_type: 'physical' }))}
                    />
                    Physical
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="business_type"
                      value="cloud_kitchen"
                      checked={createForm.business_type === 'cloud_kitchen'}
                      onChange={() => setCreateForm((p) => ({ ...p, business_type: 'cloud_kitchen' }))}
                    />
                    Cloud kitchen
                  </label>
                </div>
              </div>

              <div>
                <div className="lbl">Description</div>
                <textarea
                  rows={3}
                  className="inp"
                  value={createForm.description}
                  onChange={(e) => setCreateForm((p) => ({ ...p, description: e.target.value }))}
                  placeholder="Short description (optional)"
                />
              </div>

              <div>
                <div className="lbl">Website URL</div>
                <input
                  type="text"
                  className="inp"
                  value={createForm.website_url}
                  onChange={(e) => setCreateForm((p) => ({ ...p, website_url: e.target.value }))}
                  placeholder="https://…"
                />
              </div>

              <div>
                <div className="lbl">Phone number</div>
                <input
                  type="text"
                  className="inp"
                  value={createForm.phone_number}
                  onChange={(e) => setCreateForm((p) => ({ ...p, phone_number: e.target.value }))}
                  placeholder="+91…"
                />
              </div>

              {createForm.business_type === 'cloud_kitchen' && (
                <div>
                  <div className="lbl">Delivery zones * (one zone per line)</div>
                  <textarea
                    rows={4}
                    className="inp"
                    value={createForm.delivery_zones}
                    onChange={(e) => setCreateForm((p) => ({ ...p, delivery_zones: e.target.value }))}
                    placeholder={'Banjara Hills\nJubilee Hills\nMadhapur'}
                  />
                </div>
              )}
            </div>
            <div className="cb flex items-center justify-end gap-2 border-t border-rim">
              <button
                type="button"
                className="btn-g btn-sm"
                onClick={closeCreate}
                disabled={createBusy}
              >Cancel</button>
              <button
                type="button"
                className="btn-p btn-sm"
                onClick={onCreateSubmit}
                disabled={createBusy}
              >{createBusy ? 'Creating…' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
