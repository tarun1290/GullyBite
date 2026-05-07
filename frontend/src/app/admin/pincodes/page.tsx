'use client';

import type { ChangeEvent, ReactNode, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../../components/Toast';
import Toggle from '../../../components/Toggle';
import {
  getPincodes,
  getPincodeStats,
  getPincodeStates,
  togglePincode,
  bulkUpdatePincodes,
  importPincodes,
  getPincodeCities,
  bulkUpdateByCity,
  bulkTogglePincodes,
} from '../../../api/admin';
import type { PincodeStateSummary } from '../../../types';

const PAGE_SIZE = 50;
const CITY_PAGE_LIMIT = 200;
// Per-state lazy fetch cap. Backend GET / now allows up to 500 in one shot
// (raised from 200 specifically so a typical state's pincodes pull in one
// click — most Indian states are well under 500). If this ceiling is ever
// hit, follow up with the backend team rather than paginating in the UI.
const STATE_PINCODE_LIMIT = 500;

interface PincodeRow {
  pincode: string;
  city?: string;
  state?: string;
  area?: string | null;
  enabled?: boolean;
  updated_at?: string;
}

interface PincodesResponse {
  pincodes?: PincodeRow[];
  totalPages?: number;
  total?: number;
}

interface PincodeStats {
  total: number;
  enabled: number;
  disabled: number;
}

interface PincodeStatsApi {
  total?: number;
  enabled?: number;
  disabled?: number;
}

interface CityRowApi {
  state: string;
  city: string;
  total: number;
  enabled: number;
  disabled: number;
}

interface StateBucket {
  state: string;
  total: number;
  enabled: number;
  disabled: number;
  cities: CityRowApi[];
}

interface BulkConfirm { enabled: boolean }

interface ImportPreview { total: number; list: string[] }

interface BulkUpdateResult { updated?: number }

interface BulkToggleResult { modifiedCount?: number; matchedCount?: number; affectedRestaurants?: number }

interface ImportResult { inserted?: number; skipped?: number }

type GroupToggleVariant = 'enable' | 'disable' | 'mixed';

function classifyGroup(rowsForGroup: PincodeRow[]): GroupToggleVariant {
  if (!rowsForGroup.length) return 'enable';
  let allOn = true;
  let allOff = true;
  for (const r of rowsForGroup) {
    if (r.enabled) allOff = false;
    else allOn = false;
    if (!allOn && !allOff) break;
  }
  if (allOn) return 'disable';
  if (allOff) return 'enable';
  return 'mixed';
}

function fmtDate(d?: string): string {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

function parseCsvPincodes(text: string): string[] {
  const lines = String(text || '').split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    if (!/^[0-9]/.test(trimmed)) continue;
    const m = trimmed.match(/\b[1-9][0-9]{5}\b/);
    if (m) out.push(m[0]);
  }
  return Array.from(new Set(out));
}

function fmtNum(n: number | string | null | undefined): string {
  try { return Number(n || 0).toLocaleString('en-IN'); } catch { return String(n || 0); }
}

function cityKey(city: string, state: string): string {
  return `${state}${city}`;
}

export default function AdminPincodesPage() {
  const { showToast } = useToast();

  const [view, setView] = useState<'pincode' | 'city'>('pincode');

  const [stats, setStats] = useState<PincodeStats>({ total: 0, enabled: 0, disabled: 0 });

  const [rows, setRows] = useState<PincodeRow[]>([]);
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [total, setTotal] = useState<number>(0);
  const [search, setSearch] = useState<string>('');
  const [debounced, setDebounced] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [loading, setLoading] = useState<boolean>(true);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<BulkConfirm | null>(null);
  const [bulkBusy, setBulkBusy] = useState<boolean>(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState<boolean>(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [cityData, setCityData] = useState<CityRowApi[]>([]);
  const [cityLoading, setCityLoading] = useState<boolean>(false);
  const [openState, setOpenState] = useState<string | null>(null);
  const [expandedCity, setExpandedCity] = useState<string | null>(null);
  const [cityPincodes, setCityPincodes] = useState<Record<string, PincodeRow[]>>({});
  const [cityPinsLoading, setCityPinsLoading] = useState<boolean>(false);
  const [cityBusy, setCityBusy] = useState<string | null>(null);
  const [stateBusy, setStateBusy] = useState<string | null>(null);
  const [cityRowBusy, setCityRowBusy] = useState<string | null>(null);

  // In-table inline group toggles (separate from the "By City" view's busy
  // keys above). Keyed by state (state heading row) or "state|city" (city
  // sub-heading row inside the pincode table view).
  const [inlineGroupBusy, setInlineGroupBusy] = useState<string | null>(null);

  // Per-state expand/collapse for the grouped table. Default is empty (all
  // collapsed) so the page opens to a punchy summary list of state names +
  // counts; click a heading to drill in.
  const [expandedStates, setExpandedStates] = useState<Record<string, boolean>>({});

  // Summary-mode hooks (active whenever there is no active search).
  // `stateSummaries` is the full list of states from the $group aggregation,
  // populated once at mount via GET /api/admin/pincodes/states.
  // `stateRowsCache` holds per-state pincode rows fetched lazily on first
  // expand — keyed by state name, sticks for the lifetime of the page so
  // collapse-then-re-expand is a no-op fetch.
  // `stateRowsLoading` tracks in-flight per-state fetches so the UI can show
  // a transient "Loading…" beneath the heading without showing stale data.
  const [stateSummaries, setStateSummaries] = useState<PincodeStateSummary[]>([]);
  const [stateRowsCache, setStateRowsCache] = useState<Record<string, PincodeRow[]>>({});
  const [stateRowsLoading, setStateRowsLoading] = useState<Record<string, boolean>>({});
  const [summaryLoading, setSummaryLoading] = useState<boolean>(false);

  const refreshStats = async () => {
    try {
      const s = (await getPincodeStats()) as PincodeStatsApi | null;
      setStats({
        total: s?.total || 0,
        enabled: s?.enabled || 0,
        disabled: s?.disabled || 0,
      });
    } catch {
      /* non-fatal */
    }
  };

  // Pulls the one-row-per-state aggregation. This is the mount-time call in
  // summary mode (no active search) — drives the collapsed accordion. Cheap
  // even at 50–60 states, since the backend $group already collapses.
  const loadStateSummaries = async () => {
    setSummaryLoading(true);
    try {
      const list = await getPincodeStates();
      setStateSummaries(Array.isArray(list) ? list : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load states', 'error');
      setStateSummaries([]);
    } finally {
      setSummaryLoading(false);
    }
  };

  // Lazy-fetch the pincode rows for a single state. No-op if already cached
  // (the cache is invalidated by inline bulk toggles below). Capped at 500
  // — the backend now allows that ceiling specifically so a single state's
  // pincodes come down in one round-trip.
  const loadStateRows = async (state: string, force: boolean = false) => {
    if (!force && stateRowsCache[state]) return;
    setStateRowsLoading((prev) => ({ ...prev, [state]: true }));
    try {
      const data = (await getPincodes({
        state,
        page: 1,
        limit: STATE_PINCODE_LIMIT,
      })) as PincodesResponse | null;
      const rowsOut = Array.isArray(data?.pincodes) ? data.pincodes : [];
      setStateRowsCache((prev) => ({ ...prev, [state]: rowsOut }));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load pincodes', 'error');
    } finally {
      setStateRowsLoading((prev) => ({ ...prev, [state]: false }));
    }
  };

  // Always grouped-by-state — fetch up to 1000 rows in one shot. The
  // per-state collapsible UI keeps the DOM cheap.
  const load = async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number | undefined> = {
        page: 1,
        limit: 1000,
        search: debounced || undefined,
        status: statusFilter,
      };
      const data = (await getPincodes(params)) as PincodesResponse | null;
      setRows(Array.isArray(data?.pincodes) ? data.pincodes : []);
      setTotalPages(data?.totalPages || 1);
      setTotal(data?.total || 0);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load pincodes', 'error');
      setRows([]);
      setTotalPages(1);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  const loadCities = async () => {
    setCityLoading(true);
    try {
      const rowsOut = (await getPincodeCities()) as CityRowApi[] | null;
      setCityData(Array.isArray(rowsOut) ? rowsOut : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load cities', 'error');
      setCityData([]);
    } finally {
      setCityLoading(false);
    }
  };

  useEffect(() => { refreshStats(); }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  // In summary mode (`view === 'pincode'` AND no active search), the page
  // shows the collapsed state accordion driven by stateSummaries; the flat
  // `rows` list stays empty until the user types a search term. Once they
  // do, we fall through to the original `load()` flow which fetches the
  // matching rows via the existing GET / endpoint.
  useEffect(() => {
    if (view !== 'pincode') return;
    if (debounced) {
      load();
    } else {
      loadStateSummaries();
      // Clear the flat list from any prior search so the summary accordion
      // is the only thing on screen when search is cleared.
      setRows([]);
      setTotal(0);
      setTotalPages(1);
    }
    /* eslint-disable-next-line */
  }, [page, debounced, statusFilter, view]);

  useEffect(() => {
    if (view === 'city' && !cityData.length) loadCities();
    /* eslint-disable-next-line */
  }, [view]);

  const onStatusChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setStatusFilter(e.target.value);
    setPage(1);
  };

  const toggleStateExpansion = (state: string) => {
    setExpandedStates((prev) => {
      const willExpand = !prev[state];
      // Kick the lazy fetch only when transitioning to expanded; collapsing
      // doesn't drop the cache (collapse-then-re-expand is instant).
      if (willExpand && !debounced) {
        // Fire-and-forget — `loadStateRows` no-ops if already cached and
        // sets its own per-state loading flag for the spinner row.
        loadStateRows(state);
      }
      return { ...prev, [state]: willExpand };
    });
  };

  // Per-row toggle. In search mode the row lives in `rows`; in summary mode
  // the row lives in `stateRowsCache[state]` (lazy-loaded under each state
  // heading). We optimistically flip the row in whichever surface holds it,
  // then roll back on error.
  const handleToggle = async (pc: string, currentEnabled: boolean) => {
    const flipRow = (next: boolean) => {
      setRows((prev) => prev.map((r) => (r.pincode === pc ? { ...r, enabled: next } : r)));
      setStateRowsCache((prev) => {
        const out: Record<string, PincodeRow[]> = {};
        for (const [st, list] of Object.entries(prev)) {
          out[st] = list.map((r) => (r.pincode === pc ? { ...r, enabled: next } : r));
        }
        return out;
      });
    };
    flipRow(!currentEnabled);
    // Bump the stateSummaries enabled/disabled counts so the heading chip
    // reflects the toggle without a roundtrip. We don't know which state
    // the row is in without a lookup — use the cache reverse-map.
    let owningState: string | null = null;
    for (const [st, list] of Object.entries(stateRowsCache)) {
      if (list.some((r) => r.pincode === pc)) { owningState = st; break; }
    }
    if (owningState) {
      setStateSummaries((prev) =>
        prev.map((s) =>
          s.state === owningState
            ? {
                ...s,
                enabled_count: s.enabled_count + (currentEnabled ? -1 : 1),
                disabled_count: s.disabled_count + (currentEnabled ? 1 : -1),
              }
            : s
        )
      );
    }
    setRowBusy(pc);
    try {
      await togglePincode(pc);
      setStats((s) => ({
        ...s,
        enabled: s.enabled + (currentEnabled ? -1 : 1),
        disabled: s.disabled + (currentEnabled ? 1 : -1),
      }));
    } catch (err: unknown) {
      flipRow(currentEnabled);
      if (owningState) {
        setStateSummaries((prev) =>
          prev.map((s) =>
            s.state === owningState
              ? {
                  ...s,
                  enabled_count: s.enabled_count + (currentEnabled ? 1 : -1),
                  disabled_count: s.disabled_count + (currentEnabled ? -1 : 1),
                }
              : s
          )
        );
      }
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Toggle failed', 'error');
    } finally {
      setRowBusy(null);
    }
  };

  const doBulk = async (enabled: boolean) => {
    setBulkBusy(true);
    try {
      const res = (await bulkUpdatePincodes({
        enabled,
        filter: { search: debounced || undefined, status: statusFilter },
      })) as BulkUpdateResult | null;
      showToast(`Updated ${fmtNum(res?.updated || 0)} pincodes`, 'success');
      setBulkConfirm(null);
      await refreshStats();
      // The "Enable/Disable filtered" buttons are only available when the
      // user has typed a search (the filtered set is the visible flat list
      // — there's no filtered set in summary mode), so refreshing via
      // load() is correct here. If summary mode is active, also blow the
      // per-state cache so newly enabled/disabled rows surface on next
      // expand.
      if (debounced) {
        await load();
      } else {
        setStateRowsCache({});
        await loadStateSummaries();
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Bulk update failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const openFilePicker = () => { if (fileRef.current) fileRef.current.click(); };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const list = parseCsvPincodes(text);
      if (!list.length) {
        showToast('No valid 6-digit pincodes found in CSV', 'error');
        return;
      }
      setImportPreview({ total: list.length, list });
    } catch (err: unknown) {
      const er = err as { message?: string };
      showToast(er.message || 'CSV read failed', 'error');
    }
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    setImportBusy(true);
    try {
      const res = (await importPincodes({
        pincodes: importPreview.list,
        notes: 'Admin CSV import',
      })) as ImportResult | null;
      showToast(
        `Imported ${fmtNum(res?.inserted || 0)} new pincodes (${fmtNum(res?.skipped || 0)} already existed)`,
        'success'
      );
      setImportPreview(null);
      await refreshStats();
      // Import can add new states or rebalance counts within existing ones,
      // so refresh both surfaces. In search mode keep showing the flat list;
      // in summary mode invalidate the per-state cache so re-expand picks
      // up the new rows.
      if (debounced) {
        await load();
      } else {
        setStateRowsCache({});
        await loadStateSummaries();
      }
      if (view === 'city') await loadCities();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Import failed', 'error');
    } finally {
      setImportBusy(false);
    }
  };

  const groupedByState = useMemo<StateBucket[]>(() => {
    const byState = new Map<string, StateBucket>();
    for (const r of cityData) {
      const st = r.state || 'Other';
      if (!byState.has(st)) byState.set(st, { state: st, total: 0, enabled: 0, disabled: 0, cities: [] });
      const bucket = byState.get(st)!;
      bucket.total += r.total || 0;
      bucket.enabled += r.enabled || 0;
      bucket.disabled += r.disabled || 0;
      bucket.cities.push(r);
    }
    const out = Array.from(byState.values());
    out.sort((a, b) => b.total - a.total || a.state.localeCompare(b.state));
    for (const s of out) s.cities.sort((a, b) => b.total - a.total || a.city.localeCompare(b.city));
    return out;
  }, [cityData]);

  const toggleStateOpen = (st: string) => {
    setOpenState((prev) => (prev === st ? null : st));
    setExpandedCity(null);
  };

  const loadCityPincodes = async (city: string, state: string) => {
    const key = cityKey(city, state);
    if (cityPincodes[key]) return;
    setCityPinsLoading(true);
    try {
      const data = (await getPincodes({ city, state, limit: CITY_PAGE_LIMIT, page: 1 })) as PincodesResponse | null;
      setCityPincodes((prev) => ({
        ...prev,
        [key]: Array.isArray(data?.pincodes) ? data.pincodes : [],
      }));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load pincodes', 'error');
    } finally {
      setCityPinsLoading(false);
    }
  };

  const toggleCityPanel = async (city: string, state: string) => {
    const key = cityKey(city, state);
    if (expandedCity === key) {
      setExpandedCity(null);
      return;
    }
    setExpandedCity(key);
    await loadCityPincodes(city, state);
  };

  const applyCityDelta = (city: string, state: string, delta: number) => {
    setCityData((prev) =>
      prev.map((r) =>
        r.city === city && r.state === state
          ? {
              ...r,
              enabled: Math.max(0, Math.min(r.total, r.enabled + delta)),
              disabled: Math.max(0, Math.min(r.total, r.disabled - delta)),
            }
          : r
      )
    );
    setStats((s) => ({
      ...s,
      enabled: s.enabled + delta,
      disabled: s.disabled - delta,
    }));
  };

  const setCityFullyEnabled = (city: string, state: string, enabled: boolean) => {
    setCityData((prev) =>
      prev.map((r) =>
        r.city === city && r.state === state
          ? {
              ...r,
              enabled: enabled ? r.total : 0,
              disabled: enabled ? 0 : r.total,
            }
          : r
      )
    );
  };

  const doCityBulk = async (city: string, state: string, enabled: boolean) => {
    const key = cityKey(city, state);
    setCityBusy(key);
    try {
      const res = (await bulkUpdateByCity({ city, state, enabled })) as BulkUpdateResult | null;
      setCityFullyEnabled(city, state, enabled);
      setCityPincodes((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (expandedCity === key) await loadCityPincodes(city, state);
      await refreshStats();
      showToast(
        `${enabled ? 'Enabled' : 'Disabled'} ${fmtNum(res?.updated || 0)} pincodes in ${city}`,
        'success'
      );
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'City update failed', 'error');
    } finally {
      setCityBusy(null);
    }
  };

  const doStateBulk = async (stateBucket: StateBucket, enabled: boolean) => {
    setStateBusy(stateBucket.state);
    try {
      for (const c of stateBucket.cities) {
        await bulkUpdateByCity({ city: c.city, state: c.state, enabled });
      }
      await loadCities();
      await refreshStats();
      setCityPincodes((prev) => {
        const next = { ...prev };
        for (const c of stateBucket.cities) delete next[cityKey(c.city, c.state)];
        return next;
      });
      showToast(`${enabled ? 'Enabled' : 'Disabled'} all pincodes in ${stateBucket.state}`, 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'State update failed', 'error');
    } finally {
      setStateBusy(null);
    }
  };

  // In-table state/city bulk toggle. Calls the new
  // PATCH /api/admin/pincodes/bulk-toggle endpoint and refreshes the
  // current pincode page + stats. `city` is optional — omit for
  // state-scoped bulk action.
  const doInlineBulkToggle = async (state: string, city: string | undefined, active: boolean) => {
    const key = city ? `${state}|${city}` : state;
    setInlineGroupBusy(key);
    try {
      const filter: { state: string; city?: string } = { state };
      if (city) filter.city = city;
      const res = (await bulkTogglePincodes({ filter, active })) as BulkToggleResult | null;
      const n = res?.modifiedCount || 0;
      await refreshStats();
      // Refresh path differs by mode:
      //  - search mode (`debounced`): the user is looking at a flat filtered
      //    list, so reload it via the existing GET / call.
      //  - summary mode: invalidate just the affected state's per-state row
      //    cache + force-reload it (so the inline toggle shows immediately
      //    on the rows beneath the heading) and refresh stateSummaries so
      //    the count chip on the heading flips with the toggle.
      if (debounced) {
        await load();
      } else {
        await Promise.all([
          loadStateRows(state, true),
          loadStateSummaries(),
        ]);
      }
      // City counts feed both dropdowns and the "By City" view; refresh so
      // they stay in sync with the inline toggle.
      await loadCities();
      const scope = city ? `${city}, ${state}` : state;
      showToast(
        `${active ? 'Enabled' : 'Disabled'} ${fmtNum(n)} pincodes in ${scope}`,
        'success'
      );
      // Disable-only follow-up: warn the admin if any tenants have a
      // branch in the just-disabled area. Informational — the backend
      // does not auto-pause those tenants.
      const affected = res?.affectedRestaurants || 0;
      if (!active && affected > 0) {
        showToast(
          `${fmtNum(n)} pincodes disabled. ${fmtNum(affected)} restaurant${affected === 1 ? '' : 's'} in this area may no longer be serviceable.`,
          'warning'
        );
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Bulk toggle failed', 'error');
    } finally {
      setInlineGroupBusy(null);
    }
  };

  const handleCityPinToggle = async (city: string, state: string, pc: string, currentEnabled: boolean) => {
    const key = cityKey(city, state);
    setCityPincodes((prev) => ({
      ...prev,
      [key]: (prev[key] || []).map((p) =>
        p.pincode === pc ? { ...p, enabled: !currentEnabled } : p
      ),
    }));
    applyCityDelta(city, state, currentEnabled ? -1 : 1);
    setCityRowBusy(pc);
    try {
      await togglePincode(pc);
    } catch (err: unknown) {
      setCityPincodes((prev) => ({
        ...prev,
        [key]: (prev[key] || []).map((p) =>
          p.pincode === pc ? { ...p, enabled: currentEnabled } : p
        ),
      }));
      applyCityDelta(city, state, currentEnabled ? 1 : -1);
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Toggle failed', 'error');
    } finally {
      setCityRowBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="card">
        <div className="cb grid grid-cols-3 gap-4">
          <StatBlock label="Total pincodes" value={fmtNum(stats.total)} color="var(--fg)" />
          <StatBlock label="Enabled" value={fmtNum(stats.enabled)} color="var(--gb-wa-500)" />
          <StatBlock label="Disabled" value={fmtNum(stats.disabled)} color="var(--gb-red-500)" />
        </div>
      </div>

      <div className="card">
        <div className="cb flex gap-[0.4rem] items-center flex-wrap">
          <span className="text-[0.8rem] text-dim">View:</span>
          <button
            type="button"
            className={view === 'pincode' ? 'btn-p btn-sm' : 'btn-g btn-sm'}
            aria-pressed={view === 'pincode'}
            onClick={() => setView('pincode')}
          >
            By Pincode
          </button>
          <button
            type="button"
            className={view === 'city' ? 'btn-p btn-sm' : 'btn-g btn-sm'}
            aria-pressed={view === 'city'}
            onClick={() => setView('city')}
          >
            By City
          </button>
          <span className="ml-auto text-[0.75rem] text-dim">
            Changes apply platform-wide.
          </span>
        </div>
      </div>

      {view === 'pincode' && (
        <PincodeView
          search={search}
          setSearch={setSearch}
          debounced={debounced}
          statusFilter={statusFilter}
          onStatusChange={onStatusChange}
          bulkConfirm={bulkConfirm}
          setBulkConfirm={setBulkConfirm}
          bulkBusy={bulkBusy}
          doBulk={doBulk}
          loading={loading}
          total={total}
          openFilePicker={openFilePicker}
          fileRef={fileRef}
          handleFile={handleFile}
          importPreview={importPreview}
          setImportPreview={setImportPreview}
          importBusy={importBusy}
          confirmImport={confirmImport}
          rows={rows}
          rowBusy={rowBusy}
          handleToggle={handleToggle}
          inlineGroupBusy={inlineGroupBusy}
          doInlineBulkToggle={doInlineBulkToggle}
          expandedStates={expandedStates}
          toggleStateExpansion={toggleStateExpansion}
          stateSummaries={stateSummaries}
          stateRowsCache={stateRowsCache}
          stateRowsLoading={stateRowsLoading}
          summaryLoading={summaryLoading}
        />
      )}

      {view === 'city' && (
        <CityView
          cityLoading={cityLoading}
          groupedByState={groupedByState}
          openState={openState}
          toggleStateOpen={toggleStateOpen}
          stateBusy={stateBusy}
          doStateBulk={doStateBulk}
          expandedCity={expandedCity}
          toggleCityPanel={toggleCityPanel}
          cityBusy={cityBusy}
          doCityBulk={doCityBulk}
          cityPincodes={cityPincodes}
          cityPinsLoading={cityPinsLoading}
          cityRowBusy={cityRowBusy}
          handleCityPinToggle={handleCityPinToggle}
        />
      )}
    </div>
  );
}

interface PincodeViewProps {
  search: string;
  setSearch: (v: string) => void;
  // The debounced search term — empty string ↔ summary mode (state
  // accordion). Distinguishes mid-type "search" (user just typed a char,
  // debounce hasn't fired yet) from the actual data-fetch trigger.
  debounced: string;
  statusFilter: string;
  onStatusChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  bulkConfirm: BulkConfirm | null;
  setBulkConfirm: (next: BulkConfirm | null) => void;
  bulkBusy: boolean;
  doBulk: (enabled: boolean) => void;
  loading: boolean;
  total: number;
  openFilePicker: () => void;
  fileRef: RefObject<HTMLInputElement | null>;
  handleFile: (e: ChangeEvent<HTMLInputElement>) => void;
  importPreview: ImportPreview | null;
  setImportPreview: (next: ImportPreview | null) => void;
  importBusy: boolean;
  confirmImport: () => void;
  rows: PincodeRow[];
  rowBusy: string | null;
  handleToggle: (pc: string, currentEnabled: boolean) => void;
  inlineGroupBusy: string | null;
  doInlineBulkToggle: (state: string, city: string | undefined, active: boolean) => Promise<void>;
  expandedStates: Record<string, boolean>;
  toggleStateExpansion: (state: string) => void;
  // Summary-mode payload. Empty array + `summaryLoading=true` means the
  // mount-time GET /states call is still in flight; empty array +
  // `summaryLoading=false` means the DB has no states yet (fresh tenant).
  stateSummaries: PincodeStateSummary[];
  stateRowsCache: Record<string, PincodeRow[]>;
  stateRowsLoading: Record<string, boolean>;
  summaryLoading: boolean;
}

function PincodeView(p: PincodeViewProps) {
  return (
    <div className="card">
      <div className="ch flex-wrap gap-2">
        <h3>📍 Pincode Serviceability</h3>
        <div className="flex gap-[0.4rem] ml-auto flex-wrap items-center">
          <input
            value={p.search}
            onChange={(e) => p.setSearch(e.target.value)}
            placeholder="Search pincode, city, state, area…"
            className="py-[0.35rem] px-2"
          />
          <select
            value={p.statusFilter}
            onChange={p.onStatusChange}
            className="py-[0.35rem] px-2"
          >
            <option value="all">All</option>
            <option value="enabled">Enabled only</option>
            <option value="disabled">Disabled only</option>
          </select>
          {p.bulkConfirm ? (
            <span className="inline-flex gap-[0.4rem] items-center">
              <span className="text-[0.75rem] text-dim">
                {p.bulkConfirm.enabled ? 'Enable' : 'Disable'} all {fmtNum(p.total)} filtered?
              </span>
              <button
                type="button"
                className={p.bulkConfirm.enabled ? 'btn-p btn-sm' : 'btn-del btn-sm'}
                onClick={() => p.bulkConfirm && p.doBulk(p.bulkConfirm.enabled)}
                disabled={p.bulkBusy}
              >
                {p.bulkBusy ? '…' : 'Confirm'}
              </button>
              <button className="btn-sm btn-g" onClick={() => p.setBulkConfirm(null)} disabled={p.bulkBusy}>
                Cancel
              </button>
            </span>
          ) : (
            <>
              <button
                className="btn-sm btn-g"
                onClick={() => p.setBulkConfirm({ enabled: true })}
                disabled={p.loading || p.total === 0}
              >
                Enable filtered
              </button>
              <button
                className="btn-sm btn-g"
                onClick={() => p.setBulkConfirm({ enabled: false })}
                disabled={p.loading || p.total === 0}
              >
                Disable filtered
              </button>
              <button className="btn-sm btn-p" onClick={p.openFilePicker}>
                Import CSV
              </button>
              <input
                ref={p.fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={p.handleFile}
              />
            </>
          )}
        </div>
      </div>

      {p.importPreview && (
        <div className="cb border-b border-bd bg-[rgba(253,224,71,0.12)] flex gap-2 items-center flex-wrap">
          <span className="text-[0.85rem]">
            Found <strong>{fmtNum(p.importPreview.total)}</strong> valid pincodes in CSV.
            New rows start enabled; existing rows keep their current toggle.
          </span>
          <button
            className="btn-sm btn-p ml-auto"
            onClick={p.confirmImport}
            disabled={p.importBusy}
          >
            {p.importBusy ? 'Importing…' : 'Confirm import'}
          </button>
          <button
            className="btn-sm btn-g"
            onClick={() => p.setImportPreview(null)}
            disabled={p.importBusy}
          >
            Cancel
          </button>
        </div>
      )}

      <div className="cb">
        {renderPincodeBody(p)}
        {renderFooter(p)}
      </div>
    </div>
  );
}

// Body renderer — picks between summary-mode (collapsed state accordion
// driven by stateSummaries + lazy-loaded stateRowsCache) and search-mode
// (flat filtered rows from the existing GET / endpoint).
function renderPincodeBody(p: PincodeViewProps): ReactNode {
  const summaryMode = !p.debounced;

  if (summaryMode) {
    if (p.summaryLoading && !p.stateSummaries.length) {
      return <p>Loading states…</p>;
    }
    if (!p.stateSummaries.length) {
      return <p className="text-dim">No pincodes loaded yet. Import a CSV to get started.</p>;
    }
    return (
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-[0.75rem] text-dim">
            <th className="py-[0.4rem] px-[0.2rem]">Pincode</th>
            <th className="py-[0.4rem] px-[0.2rem]">City</th>
            <th className="py-[0.4rem] px-[0.2rem]">Area</th>
            <th className="py-[0.4rem] px-[0.2rem]">State</th>
            <th className="py-[0.4rem] px-[0.2rem]">Status</th>
            <th className="py-[0.4rem] px-[0.2rem]">Last Updated</th>
          </tr>
        </thead>
        <tbody>{renderSummaryRows(p)}</tbody>
      </table>
    );
  }

  // Search mode — original flat-list flow.
  if (p.loading) return <p>Loading…</p>;
  if (!p.rows.length) return <p className="text-dim">No pincodes match the current filter.</p>;
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="text-left text-[0.75rem] text-dim">
          <th className="py-[0.4rem] px-[0.2rem]">Pincode</th>
          <th className="py-[0.4rem] px-[0.2rem]">City</th>
          <th className="py-[0.4rem] px-[0.2rem]">Area</th>
          <th className="py-[0.4rem] px-[0.2rem]">State</th>
          <th className="py-[0.4rem] px-[0.2rem]">Status</th>
          <th className="py-[0.4rem] px-[0.2rem]">Last Updated</th>
        </tr>
      </thead>
      <tbody>{renderPincodeRows(p)}</tbody>
    </table>
  );
}

function renderFooter(p: PincodeViewProps): ReactNode {
  const summaryMode = !p.debounced;
  if (summaryMode) {
    const totalPincodes = p.stateSummaries.reduce((s, r) => s + (r.total_pincodes || 0), 0);
    return (
      <div className="mt-[0.8rem] text-[0.75rem] text-dim">
        {fmtNum(p.stateSummaries.length)} state{p.stateSummaries.length === 1 ? '' : 's'} ·{' '}
        {fmtNum(totalPincodes)} pincode{totalPincodes === 1 ? '' : 's'} total. Click a state to expand.
      </div>
    );
  }
  return (
    <div className="mt-[0.8rem] text-[0.75rem] text-dim">
      Showing {fmtNum(p.rows.length)} of {fmtNum(p.total)} pincodes matching “{p.debounced}”.
    </div>
  );
}

// Summary-mode renderer. Iterates the full list of stateSummaries (from the
// $group aggregation) so EVERY state is in the accordion regardless of how
// many pincodes it has. Per-state pincode rows come from `stateRowsCache`,
// populated lazily on first expand. The per-state spinner row reads from
// `stateRowsLoading[state]`.
function renderSummaryRows(p: PincodeViewProps): ReactNode[] {
  const sortByCityPincode = (a: PincodeRow, b: PincodeRow): number => {
    const ca = (a.city || '').localeCompare(b.city || '');
    if (ca !== 0) return ca;
    return a.pincode.localeCompare(b.pincode);
  };

  const out: ReactNode[] = [];
  p.stateSummaries.forEach((sum, i) => {
    const st = sum.state;
    const isExpanded = !!p.expandedStates[st];
    const rowsForState = p.stateRowsCache[st];
    const rowsLoading = !!p.stateRowsLoading[st];

    out.push(
      <StateHeaderRow
        key={`hdr-${st}`}
        state={st}
        rowsForState={rowsForState || []}
        summary={sum}
        inlineGroupBusy={p.inlineGroupBusy}
        doInlineBulkToggle={p.doInlineBulkToggle}
        expanded={isExpanded}
        onToggleExpand={() => p.toggleStateExpansion(st)}
      />
    );

    if (isExpanded) {
      if (rowsLoading && !rowsForState) {
        out.push(
          <tr key={`load-${st}`}>
            <td colSpan={6} className="py-[0.6rem] px-3 text-[0.8rem] text-dim">
              Loading pincodes for {st}…
            </td>
          </tr>
        );
      } else if (rowsForState && rowsForState.length) {
        const sorted = rowsForState.slice().sort(sortByCityPincode);
        const cityBuckets = new Map<string, PincodeRow[]>();
        for (const r of sorted) {
          const ck = r.city || 'Other';
          const arr = cityBuckets.get(ck);
          if (arr) arr.push(r);
          else cityBuckets.set(ck, [r]);
        }
        for (const [cityName, rowsForCity] of cityBuckets) {
          out.push(
            <CityHeaderRow
              key={`city-hdr-${st}-${cityName}`}
              state={st}
              city={cityName}
              rowsForCity={rowsForCity}
              inlineGroupBusy={p.inlineGroupBusy}
              doInlineBulkToggle={p.doInlineBulkToggle}
            />
          );
          for (const r of rowsForCity) {
            out.push(<PincodeTableRow key={`${st}-${cityName}-${r.pincode}`} r={r} p={p} />);
          }
        }
      } else if (rowsForState && !rowsForState.length) {
        out.push(
          <tr key={`empty-${st}`}>
            <td colSpan={6} className="py-[0.6rem] px-3 text-[0.8rem] text-dim">
              No pincodes returned for {st}.
            </td>
          </tr>
        );
      }
    }

    if (i < p.stateSummaries.length - 1) {
      out.push(<GroupSpacerRow key={`sp-${st}`} />);
    }
  });
  return out;
}

// Always grouped by state, with per-state collapsible accordion. Each state
// row shows the chevron / name / count / bulk-toggle button; clicking the
// row expands the state to reveal city sub-headings (with their own
// per-city bulk toggle) and the pincode rows themselves.
//
// Search-and-status filtering happens server-side (search includes area
// because the backend's text filter already covers all returned fields);
// area is only used here for display.
function renderPincodeRows(p: PincodeViewProps) {
  const sortByCityPincode = (a: PincodeRow, b: PincodeRow): number => {
    const ca = (a.city || '').localeCompare(b.city || '');
    if (ca !== 0) return ca;
    return a.pincode.localeCompare(b.pincode);
  };

  const buckets = new Map<string, PincodeRow[]>();
  for (const r of p.rows) {
    const k = r.state || 'Other';
    const arr = buckets.get(k);
    if (arr) arr.push(r);
    else buckets.set(k, [r]);
  }
  const stateEntries = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([st, rs]) => [st, rs.slice().sort(sortByCityPincode)] as const);

  const out: ReactNode[] = [];
  stateEntries.forEach(([st, rowsForState], i) => {
    const isExpanded = !!p.expandedStates[st];
    out.push(
      <StateHeaderRow
        key={`hdr-${st}`}
        state={st}
        rowsForState={rowsForState}
        inlineGroupBusy={p.inlineGroupBusy}
        doInlineBulkToggle={p.doInlineBulkToggle}
        expanded={isExpanded}
        onToggleExpand={() => p.toggleStateExpansion(st)}
      />
    );
    if (isExpanded) {
      // Bucket the state's rows by city so each city gets its own
      // sub-heading + bulk toggle. Cities sorted alphabetically; rows
      // already sorted by (city, pincode) above.
      const cityBuckets = new Map<string, PincodeRow[]>();
      for (const r of rowsForState) {
        const ck = r.city || 'Other';
        const arr = cityBuckets.get(ck);
        if (arr) arr.push(r);
        else cityBuckets.set(ck, [r]);
      }
      for (const [cityName, rowsForCity] of cityBuckets) {
        out.push(
          <CityHeaderRow
            key={`city-hdr-${st}-${cityName}`}
            state={st}
            city={cityName}
            rowsForCity={rowsForCity}
            inlineGroupBusy={p.inlineGroupBusy}
            doInlineBulkToggle={p.doInlineBulkToggle}
          />
        );
        for (const r of rowsForCity) {
          out.push(<PincodeTableRow key={`${st}-${cityName}-${r.pincode}`} r={r} p={p} />);
        }
      }
    }
    if (i < stateEntries.length - 1) {
      out.push(<GroupSpacerRow key={`sp-${st}`} />);
    }
  });
  return out;
}

interface StateHeaderRowProps {
  state: string;
  rowsForState: PincodeRow[];
  // Summary-mode payload — when present, count and variant are derived
  // from the aggregated counts (no need to wait for per-state rows to
  // arrive before showing the heading + button). When absent (search
  // mode), we fall back to scanning rowsForState in-memory.
  summary?: PincodeStateSummary;
  inlineGroupBusy: string | null;
  doInlineBulkToggle: (state: string, city: string | undefined, active: boolean) => Promise<void>;
  expanded: boolean;
  onToggleExpand: () => void;
}

function StateHeaderRow({
  state,
  rowsForState,
  summary,
  inlineGroupBusy,
  doInlineBulkToggle,
  expanded,
  onToggleExpand,
}: StateHeaderRowProps) {
  // Prefer the aggregated summary (truthful even before per-state rows are
  // fetched); fall back to scanning rowsForState in search mode where
  // there's no summary.
  let variant: GroupToggleVariant;
  let count: number;
  if (summary) {
    count = summary.total_pincodes;
    if (summary.enabled_count === summary.total_pincodes && summary.total_pincodes > 0) variant = 'disable';
    else if (summary.enabled_count === 0) variant = 'enable';
    else variant = 'mixed';
  } else {
    variant = classifyGroup(rowsForState);
    count = rowsForState.length;
  }
  const busy = inlineGroupBusy === state;
  // For variant: 'disable' (all on) → click sends active=false; for
  // 'enable' / 'mixed' → click sends active=true.
  const nextActive = variant !== 'disable';
  const label = variant === 'disable' ? 'Disable All' : 'Enable All';
  const btnClass =
    variant === 'disable' ? 'btn-del btn-sm' :
    variant === 'enable'  ? 'btn-p btn-sm'   :
    'btn-p btn-sm';

  return (
    <tr>
      <td
        colSpan={6}
        onClick={onToggleExpand}
        className="bg-ink2 py-2 px-3 text-[0.78rem] font-bold uppercase tracking-wider text-fg cursor-pointer select-none"
      >
        <div className="flex items-center gap-[0.6rem] flex-wrap">
          <span className="inline-block w-[1ch] text-center" aria-hidden>
            {expanded ? '▼' : '▶'}
          </span>
          <span>{state}</span>
          <span className="text-[0.7rem] text-dim font-medium normal-case tracking-normal">
            {fmtNum(count)} pincodes
          </span>
          {summary && (
            <span className="text-[0.65rem] text-dim font-medium normal-case tracking-normal">
              ({fmtNum(summary.enabled_count)} on · {fmtNum(summary.disabled_count)} off)
            </span>
          )}
          <button
            type="button"
            className={`${btnClass} ml-auto`}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); doInlineBulkToggle(state, undefined, nextActive); }}
            title={
              variant === 'mixed'
                ? `Mixed — click to enable all in ${state}`
                : `Click to ${nextActive ? 'enable' : 'disable'} all in ${state}`
            }
          >
            {busy ? '…' : label}
          </button>
        </div>
      </td>
    </tr>
  );
}

interface CityHeaderRowProps {
  state: string;
  city: string;
  rowsForCity: PincodeRow[];
  inlineGroupBusy: string | null;
  doInlineBulkToggle: (state: string, city: string | undefined, active: boolean) => Promise<void>;
}

function CityHeaderRow({ state, city, rowsForCity, inlineGroupBusy, doInlineBulkToggle }: CityHeaderRowProps) {
  const variant = classifyGroup(rowsForCity);
  const key = `${state}|${city}`;
  const busy = inlineGroupBusy === key;
  const nextActive = variant !== 'disable';
  const label = variant === 'disable' ? 'Disable All' : 'Enable All';
  const btnClass =
    variant === 'disable' ? 'btn-del btn-sm' :
    variant === 'enable'  ? 'btn-p btn-sm'   :
    'btn-p btn-sm';

  return (
    <tr>
      <td
        colSpan={6}
        className="bg-[rgba(127,127,127,0.08)] py-[0.4rem] px-3 text-[0.78rem] font-semibold text-fg"
      >
        <div className="flex items-center gap-[0.6rem] flex-wrap">
          <span>{city}</span>
          <span className="text-[0.7rem] text-dim font-medium">
            {fmtNum(rowsForCity.length)} pincodes
          </span>
          <button
            type="button"
            className={`${btnClass} ml-auto`}
            disabled={busy}
            onClick={() => doInlineBulkToggle(state, city, nextActive)}
            title={
              variant === 'mixed'
                ? `Mixed — click to enable all in ${city}`
                : `Click to ${nextActive ? 'enable' : 'disable'} all in ${city}`
            }
          >
            {busy ? '…' : label}
          </button>
        </div>
      </td>
    </tr>
  );
}

// Full-width visual break between state (or city) groups in the table.
function GroupSpacerRow({ subtle = false }: { subtle?: boolean }) {
  return (
    <tr className="bg-transparent pointer-events-none h-6">
      <td colSpan={6} className="p-0">
        <div className={subtle ? 'border-t border-bd' : 'border-t-2 border-bd'} />
      </td>
    </tr>
  );
}

interface PincodeTableRowProps { r: PincodeRow; p: PincodeViewProps }

function PincodeTableRow({ r, p }: PincodeTableRowProps) {
  return (
    <tr className="border-t border-bd">
      <td className="py-[0.4rem] px-[0.2rem] font-mono">{r.pincode}</td>
      <td className="py-[0.4rem] px-[0.2rem] text-[0.85rem]">{r.city || '—'}</td>
      <td className={`py-[0.4rem] px-[0.2rem] text-[0.85rem] ${r.area ? '' : 'text-dim'}`}>
        {r.area || '—'}
      </td>
      <td className="py-[0.4rem] px-[0.2rem] text-[0.85rem] text-dim">{r.state || '—'}</td>
      <td className="py-[0.4rem] px-[0.2rem]">
        <span className="inline-flex gap-[0.4rem] items-center">
          <Toggle
            checked={!!r.enabled}
            disabled={p.rowBusy === r.pincode}
            onChange={() => p.handleToggle(r.pincode, !!r.enabled)}
          />
          <span className={`text-[0.75rem] font-medium ${r.enabled ? 'text-wa-500' : 'text-red-500'}`}>
            {r.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </span>
      </td>
      <td className="py-[0.4rem] px-[0.2rem] text-[0.8rem] text-dim">
        {fmtDate(r.updated_at)}
      </td>
    </tr>
  );
}

interface CityViewProps {
  cityLoading: boolean;
  groupedByState: StateBucket[];
  openState: string | null;
  toggleStateOpen: (st: string) => void;
  stateBusy: string | null;
  doStateBulk: (bucket: StateBucket, enabled: boolean) => Promise<void>;
  expandedCity: string | null;
  toggleCityPanel: (city: string, state: string) => Promise<void>;
  cityBusy: string | null;
  doCityBulk: (city: string, state: string, enabled: boolean) => Promise<void>;
  cityPincodes: Record<string, PincodeRow[]>;
  cityPinsLoading: boolean;
  cityRowBusy: string | null;
  handleCityPinToggle: (city: string, state: string, pc: string, currentEnabled: boolean) => Promise<void>;
}

function CityView(p: CityViewProps) {
  if (p.cityLoading && !p.groupedByState.length) {
    return (
      <div className="card">
        <div className="cb"><p>Loading cities…</p></div>
      </div>
    );
  }
  if (!p.groupedByState.length) {
    return (
      <div className="card">
        <div className="cb"><p className="text-dim">No city data yet. Import pincodes to get started.</p></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[0.6rem]">
      {p.groupedByState.map((st) => (
        <StateAccordion
          key={st.state}
          bucket={st}
          isOpen={p.openState === st.state}
          onToggle={() => p.toggleStateOpen(st.state)}
          stateBusy={p.stateBusy === st.state}
          doStateBulk={p.doStateBulk}
          expandedCity={p.expandedCity}
          toggleCityPanel={p.toggleCityPanel}
          cityBusy={p.cityBusy}
          doCityBulk={p.doCityBulk}
          cityPincodes={p.cityPincodes}
          cityPinsLoading={p.cityPinsLoading}
          cityRowBusy={p.cityRowBusy}
          handleCityPinToggle={p.handleCityPinToggle}
        />
      ))}
    </div>
  );
}

interface StateAccordionProps {
  bucket: StateBucket;
  isOpen: boolean;
  onToggle: () => void;
  stateBusy: boolean;
  doStateBulk: (bucket: StateBucket, enabled: boolean) => Promise<void>;
  expandedCity: string | null;
  toggleCityPanel: (city: string, state: string) => Promise<void>;
  cityBusy: string | null;
  doCityBulk: (city: string, state: string, enabled: boolean) => Promise<void>;
  cityPincodes: Record<string, PincodeRow[]>;
  cityPinsLoading: boolean;
  cityRowBusy: string | null;
  handleCityPinToggle: (city: string, state: string, pc: string, currentEnabled: boolean) => Promise<void>;
}

function StateAccordion({
  bucket,
  isOpen,
  onToggle,
  stateBusy,
  doStateBulk,
  expandedCity,
  toggleCityPanel,
  cityBusy,
  doCityBulk,
  cityPincodes,
  cityPinsLoading,
  cityRowBusy,
  handleCityPinToggle,
}: StateAccordionProps) {
  const [stateConfirm, setStateConfirm] = useState<BulkConfirm | null>(null);

  const pct = bucket.total > 0 ? Math.round((bucket.enabled / bucket.total) * 100) : 0;

  return (
    <div className="card">
      <div
        className="ch cursor-pointer flex items-center gap-[0.6rem] flex-wrap"
        onClick={onToggle}
      >
        <span className="text-[0.9rem]">{isOpen ? '▾' : '▸'}</span>
        <h3 className="m-0">{bucket.state}</h3>
        <span className="text-[0.75rem] text-dim">
          {bucket.cities.length} {bucket.cities.length === 1 ? 'city' : 'cities'} • {fmtNum(bucket.total)} pincodes
        </span>
        <span className="text-[0.75rem] text-wa-500 font-medium ml-[0.4rem]">
          {fmtNum(bucket.enabled)} enabled
        </span>
        <span className="text-[0.75rem] text-red-500 font-medium">
          {fmtNum(bucket.disabled)} disabled
        </span>
        <div
          className="ml-auto flex gap-[0.4rem] items-center"
          onClick={(e) => e.stopPropagation()}
        >
          {stateConfirm ? (
            <>
              <span className="text-[0.75rem] text-dim">
                {stateConfirm.enabled ? 'Enable' : 'Disable'} all {bucket.cities.length} cities?
              </span>
              <button
                type="button"
                className={stateConfirm.enabled ? 'btn-p btn-sm' : 'btn-del btn-sm'}
                onClick={async () => {
                  await doStateBulk(bucket, stateConfirm.enabled);
                  setStateConfirm(null);
                }}
                disabled={stateBusy}
              >
                {stateBusy ? '…' : 'Confirm'}
              </button>
              <button
                className="btn-sm btn-g"
                onClick={() => setStateConfirm(null)}
                disabled={stateBusy}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                className="btn-sm btn-g"
                onClick={() => setStateConfirm({ enabled: true })}
                disabled={stateBusy}
              >
                Enable all
              </button>
              <button
                className="btn-sm btn-g"
                onClick={() => setStateConfirm({ enabled: false })}
                disabled={stateBusy}
              >
                Disable all
              </button>
            </>
          )}
        </div>
      </div>

      {isOpen && (
        <div className="cb flex flex-col gap-[0.6rem]">
          <ProgressBar pct={pct} />
          {bucket.cities.map((c) => (
            <CityCard
              key={`${c.state}-${c.city}`}
              row={c}
              expanded={expandedCity === cityKey(c.city, c.state)}
              onExpandToggle={() => toggleCityPanel(c.city, c.state)}
              busy={cityBusy === cityKey(c.city, c.state)}
              doCityBulk={doCityBulk}
              pins={cityPincodes[cityKey(c.city, c.state)]}
              pinsLoading={cityPinsLoading}
              cityRowBusy={cityRowBusy}
              handleCityPinToggle={handleCityPinToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CityCardProps {
  row: CityRowApi;
  expanded: boolean;
  onExpandToggle: () => void;
  busy: boolean;
  doCityBulk: (city: string, state: string, enabled: boolean) => Promise<void>;
  pins?: PincodeRow[];
  pinsLoading: boolean;
  cityRowBusy: string | null;
  handleCityPinToggle: (city: string, state: string, pc: string, currentEnabled: boolean) => Promise<void>;
}

function CityCard({
  row,
  expanded,
  onExpandToggle,
  busy,
  doCityBulk,
  pins,
  pinsLoading,
  cityRowBusy,
  handleCityPinToggle,
}: CityCardProps) {
  const [confirm, setConfirm] = useState<BulkConfirm | null>(null);
  const pct = row.total > 0 ? Math.round((row.enabled / row.total) * 100) : 0;

  return (
    <div className="border border-bd rounded-md py-[0.6rem] px-[0.7rem] flex flex-col gap-2 bg-bg2">
      <div className="flex items-center gap-[0.6rem] flex-wrap">
        <strong>{row.city}</strong>
        <span className="text-[0.75rem] text-dim">
          {fmtNum(row.enabled)} / {fmtNum(row.total)} enabled
        </span>
        <span className="text-[0.7rem] text-dim">({pct}%)</span>
        <div className="ml-auto flex gap-[0.4rem] items-center flex-wrap">
          {confirm ? (
            <>
              <span className="text-[0.7rem] text-dim">
                {confirm.enabled ? 'Enable' : 'Disable'} {fmtNum(row.total)}?
              </span>
              <button
                type="button"
                className={confirm.enabled ? 'btn-p btn-sm' : 'btn-del btn-sm'}
                onClick={async () => {
                  await doCityBulk(row.city, row.state, confirm.enabled);
                  setConfirm(null);
                }}
                disabled={busy}
              >
                {busy ? '…' : 'Confirm'}
              </button>
              <button className="btn-sm btn-g" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                className="btn-sm btn-g"
                onClick={() => setConfirm({ enabled: true })}
                disabled={busy || row.enabled === row.total}
              >
                Enable all
              </button>
              <button
                className="btn-sm btn-g"
                onClick={() => setConfirm({ enabled: false })}
                disabled={busy || row.disabled === row.total}
              >
                Disable all
              </button>
              <button className="btn-sm btn-g" onClick={onExpandToggle}>
                {expanded ? 'Hide' : 'Show'} pincodes
              </button>
            </>
          )}
        </div>
      </div>

      <ProgressBar pct={pct} />

      {expanded && (
        <div className="border-t border-dashed border-bd pt-2 mt-[0.2rem]">
          {pinsLoading && !pins ? (
            <p className="text-[0.8rem] text-dim">Loading pincodes…</p>
          ) : !pins || !pins.length ? (
            <p className="text-[0.8rem] text-dim">No pincodes in this city.</p>
          ) : (
            <div className="flex flex-wrap gap-[0.4rem]">
              {pins.map((pc) => (
                <PincodeChip
                  key={pc.pincode}
                  pincode={pc.pincode}
                  enabled={!!pc.enabled}
                  disabled={cityRowBusy === pc.pincode}
                  onToggle={() => handleCityPinToggle(row.city, row.state, pc.pincode, !!pc.enabled)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface PincodeChipProps { pincode: string; enabled: boolean; disabled: boolean; onToggle: () => void }

function PincodeChip({ pincode, enabled, disabled, onToggle }: PincodeChipProps) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      title={enabled ? 'Click to disable' : 'Click to enable'}
      className={[
        'font-mono text-[0.8rem] py-1 px-2 rounded-xs border',
        enabled
          ? 'border-wa-500 bg-[rgba(22,163,74,0.1)] text-wa-500'
          : 'border-red-500 bg-[rgba(220,38,38,0.1)] text-red-500',
        disabled ? 'cursor-wait opacity-50' : 'cursor-pointer opacity-100',
      ].join(' ')}
    >
      {pincode}
    </button>
  );
}

interface ProgressBarProps { pct: number }

function ProgressBar({ pct }: ProgressBarProps) {
  return (
    <div className="h-[6px] bg-[rgba(220,38,38,0.15)] rounded-[3px] overflow-hidden">
      {/* width is dynamic — driven by runtime pct (0–100) so cannot be a static class */}
      <div
        className="h-full bg-wa-500 transition-[width] duration-250 ease-in-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

interface StatBlockProps { label: string; value: string; color: string }

function StatBlock({ label, value, color }: StatBlockProps) {
  return (
    <div>
      <div className="text-[0.75rem] text-dim mb-[0.2rem]">{label}</div>
      {/* color is dynamic — passed in from caller based on stat type */}
      <div className="text-[1.6rem] font-semibold" style={{ color }}>{value}</div>
    </div>
  );
}
