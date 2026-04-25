'use client';

import type { CSSProperties, ChangeEvent, ReactNode, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../../components/Toast';
import Toggle from '../../../components/Toggle';
import {
  getPincodes,
  getPincodeStats,
  togglePincode,
  bulkUpdatePincodes,
  importPincodes,
  getPincodeCities,
  bulkUpdateByCity,
} from '../../../api/admin';

const PAGE_SIZE = 50;
const CITY_PAGE_LIMIT = 200;

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

interface ImportResult { inserted?: number; skipped?: number }

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
  // '' = "All States" / "All Cities". Server-side filters when set.
  const [stateFilter, setStateFilter] = useState<string>('');
  const [cityFilter, setCityFilter] = useState<string>('');
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

  // When both filters are "All" we render a single grouped-by-state list and
  // skip pagination — fetch up to 1000 rows in one shot. When either filter
  // is set, fall back to the existing 50-per-page behaviour.
  const isGroupedMode = stateFilter === '' && cityFilter === '';

  const load = async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number | undefined> = {
        page: isGroupedMode ? 1 : page,
        limit: isGroupedMode ? 1000 : PAGE_SIZE,
        search: debounced || undefined,
        status: statusFilter,
      };
      if (stateFilter) params.state = stateFilter;
      if (cityFilter)  params.city  = cityFilter;
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

  useEffect(() => {
    if (view === 'pincode') load();
    /* eslint-disable-next-line */
  }, [page, debounced, statusFilter, stateFilter, cityFilter, view]);

  useEffect(() => {
    if (view === 'city' && !cityData.length) loadCities();
    /* eslint-disable-next-line */
  }, [view]);

  // cityData is what /admin/pincodes/cities returns — used by both the "By
  // City" view and the new state/city dropdowns in PincodeView. Loaded
  // eagerly so the dropdowns are populated on first render in either view.
  useEffect(() => {
    if (!cityData.length) loadCities();
    /* eslint-disable-next-line */
  }, []);

  const stateOptions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const r of cityData) if (r.state) set.add(r.state);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [cityData]);

  const cityOptions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const r of cityData) {
      if (!r.city) continue;
      if (stateFilter && r.state !== stateFilter) continue;
      set.add(r.city);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [cityData, stateFilter]);

  const onStateFilterChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setStateFilter(e.target.value);
    setCityFilter('');         // resets City dropdown when State changes
    setPage(1);
  };
  const onCityFilterChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setCityFilter(e.target.value);
    setPage(1);
  };

  const onStatusChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setStatusFilter(e.target.value);
    setPage(1);
  };

  const handleToggle = async (pc: string, currentEnabled: boolean) => {
    setRows((prev) => prev.map((r) => (r.pincode === pc ? { ...r, enabled: !currentEnabled } : r)));
    setRowBusy(pc);
    try {
      await togglePincode(pc);
      setStats((s) => ({
        ...s,
        enabled: s.enabled + (currentEnabled ? -1 : 1),
        disabled: s.disabled + (currentEnabled ? 1 : -1),
      }));
    } catch (err: unknown) {
      setRows((prev) => prev.map((r) => (r.pincode === pc ? { ...r, enabled: currentEnabled } : r)));
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
      await load();
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
      await load();
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="card">
        <div
          className="cb"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '1rem' }}
        >
          <StatBlock label="Total pincodes" value={fmtNum(stats.total)} color="var(--fg)" />
          <StatBlock label="Enabled" value={fmtNum(stats.enabled)} color="var(--gb-wa-500)" />
          <StatBlock label="Disabled" value={fmtNum(stats.disabled)} color="var(--gb-red-500)" />
        </div>
      </div>

      <div className="card">
        <div className="cb" style={{ display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>View:</span>
          <button
            className="btn-sm"
            style={{
              background: view === 'pincode' ? 'var(--pri)' : 'transparent',
              color: view === 'pincode' ? 'var(--gb-neutral-0)' : 'var(--fg)',
              border: view === 'pincode' ? 'none' : '1px solid var(--bd)',
            }}
            onClick={() => setView('pincode')}
          >
            By Pincode
          </button>
          <button
            className="btn-sm"
            style={{
              background: view === 'city' ? 'var(--pri)' : 'transparent',
              color: view === 'city' ? 'var(--gb-neutral-0)' : 'var(--fg)',
              border: view === 'city' ? 'none' : '1px solid var(--bd)',
            }}
            onClick={() => setView('city')}
          >
            By City
          </button>
          <span style={{ marginLeft: 'auto', fontSize: '.75rem', color: 'var(--dim)' }}>
            Changes apply platform-wide.
          </span>
        </div>
      </div>

      {view === 'pincode' && (
        <PincodeView
          search={search}
          setSearch={setSearch}
          statusFilter={statusFilter}
          onStatusChange={onStatusChange}
          stateFilter={stateFilter}
          cityFilter={cityFilter}
          stateOptions={stateOptions}
          cityOptions={cityOptions}
          onStateFilterChange={onStateFilterChange}
          onCityFilterChange={onCityFilterChange}
          isGroupedMode={isGroupedMode}
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
          page={page}
          setPage={setPage}
          totalPages={totalPages}
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
  statusFilter: string;
  onStatusChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  stateFilter: string;
  cityFilter: string;
  stateOptions: string[];
  cityOptions: string[];
  onStateFilterChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  onCityFilterChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  isGroupedMode: boolean;
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
  page: number;
  setPage: (next: number | ((x: number) => number)) => void;
  totalPages: number;
}

function PincodeView(p: PincodeViewProps) {
  return (
    <div className="card">
      <div className="ch" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
        <h3>📍 Pincode Serviceability</h3>
        <div style={{ display: 'flex', gap: '.4rem', marginLeft: 'auto', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={p.search}
            onChange={(e) => p.setSearch(e.target.value)}
            placeholder="Search pincode, city, state, area…"
            style={{ padding: '.35rem .5rem' }}
          />
          <select
            value={p.stateFilter}
            onChange={p.onStateFilterChange}
            style={{ padding: '.35rem .5rem' }}
          >
            <option value="">All States</option>
            {p.stateOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={p.cityFilter}
            onChange={p.onCityFilterChange}
            style={{ padding: '.35rem .5rem' }}
          >
            <option value="">All Cities</option>
            {p.cityOptions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select
            value={p.statusFilter}
            onChange={p.onStatusChange}
            style={{ padding: '.35rem .5rem' }}
          >
            <option value="all">All</option>
            <option value="enabled">Enabled only</option>
            <option value="disabled">Disabled only</option>
          </select>
          {p.bulkConfirm ? (
            <span style={{ display: 'inline-flex', gap: '.4rem', alignItems: 'center' }}>
              <span style={{ fontSize: '.75rem', color: 'var(--dim)' }}>
                {p.bulkConfirm.enabled ? 'Enable' : 'Disable'} all {fmtNum(p.total)} filtered?
              </span>
              <button
                className="btn-sm"
                style={{ background: p.bulkConfirm.enabled ? 'var(--gb-wa-500)' : 'var(--gb-red-500)', color: 'var(--gb-neutral-0)' }}
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
                style={{ display: 'none' }}
                onChange={p.handleFile}
              />
            </>
          )}
        </div>
      </div>

      {p.importPreview && (
        <div
          className="cb"
          style={{
            borderBottom: '1px solid var(--bd)',
            background: 'rgba(253, 224, 71, 0.12)',
            display: 'flex',
            gap: '.5rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '.85rem' }}>
            Found <strong>{fmtNum(p.importPreview.total)}</strong> valid pincodes in CSV.
            New rows start enabled; existing rows keep their current toggle.
          </span>
          <button
            className="btn-sm btn-p"
            style={{ marginLeft: 'auto' }}
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
        {p.loading ? (
          <p>Loading…</p>
        ) : !p.rows.length ? (
          <p style={{ color: 'var(--dim)' }}>No pincodes match the current filter.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: '.75rem', color: 'var(--dim)' }}>
                <th style={{ padding: '.4rem .2rem' }}>Pincode</th>
                <th style={{ padding: '.4rem .2rem' }}>City</th>
                <th style={{ padding: '.4rem .2rem' }}>Area</th>
                <th style={{ padding: '.4rem .2rem' }}>State</th>
                <th style={{ padding: '.4rem .2rem' }}>Status</th>
                <th style={{ padding: '.4rem .2rem' }}>Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {renderPincodeRows(p)}
            </tbody>
          </table>
        )}

        {!p.isGroupedMode && (
          <div
            style={{
              display: 'flex',
              gap: '.4rem',
              alignItems: 'center',
              marginTop: '.8rem',
              flexWrap: 'wrap',
            }}
          >
            <button
              className="btn-sm btn-g"
              disabled={p.page <= 1 || p.loading}
              onClick={() => p.setPage((x) => Math.max(1, x - 1))}
            >
              ‹ Previous
            </button>
            <span style={{ fontSize: '.75rem', color: 'var(--dim)' }}>
              Page {p.page} of {p.totalPages} — {fmtNum(p.total)} total
            </span>
            <button
              className="btn-sm btn-g"
              disabled={p.page >= p.totalPages || p.loading}
              onClick={() => p.setPage((x) => Math.min(p.totalPages, x + 1))}
            >
              Next ›
            </button>
          </div>
        )}

        {p.isGroupedMode && (
          <div style={{ marginTop: '.8rem', fontSize: '.75rem', color: 'var(--dim)' }}>
            Showing {fmtNum(p.rows.length)} of {fmtNum(p.total)} pincodes (grouped). Filter by State or City to narrow.
          </div>
        )}
      </div>
    </div>
  );
}

// Grouped view: when both state + city are "All", group rows by state and
// render a sticky header before each group. Flat sorted view otherwise.
// Search-and-status filtering happens server-side (search includes area
// because the backend's text filter already covers all returned fields);
// area is only used here for display.
function renderPincodeRows(p: PincodeViewProps) {
  const sortByCityPincode = (a: PincodeRow, b: PincodeRow): number => {
    const ca = (a.city || '').localeCompare(b.city || '');
    if (ca !== 0) return ca;
    return a.pincode.localeCompare(b.pincode);
  };

  if (!p.isGroupedMode) {
    const sorted = [...p.rows].sort(sortByCityPincode);
    return sorted.map((r) => <PincodeTableRow key={r.pincode} r={r} p={p} />);
  }

  // Grouped: bucket by state, sort state names alphabetically, sort rows
  // within each bucket by city → pincode ascending.
  const buckets = new Map<string, PincodeRow[]>();
  for (const r of p.rows) {
    const k = r.state || 'Other';
    const arr = buckets.get(k);
    if (arr) arr.push(r);
    else buckets.set(k, [r]);
  }
  const sortedStates = Array.from(buckets.keys()).sort((a, b) => a.localeCompare(b));
  const out: ReactNode[] = [];
  for (const st of sortedStates) {
    out.push(
      <tr key={`hdr-${st}`}>
        <td
          colSpan={6}
          style={{
            background: 'var(--ink2)',
            padding: '.5rem .75rem',
            fontSize: '.75rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '.05em',
            color: 'var(--fg)',
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          {st}
        </td>
      </tr>
    );
    const rowsForState = (buckets.get(st) || []).slice().sort(sortByCityPincode);
    for (const r of rowsForState) {
      out.push(<PincodeTableRow key={`${st}-${r.pincode}`} r={r} p={p} />);
    }
  }
  return out;
}

interface PincodeTableRowProps { r: PincodeRow; p: PincodeViewProps }

function PincodeTableRow({ r, p }: PincodeTableRowProps) {
  return (
    <tr style={{ borderTop: '1px solid var(--bd)' }}>
      <td style={{ padding: '.4rem .2rem', fontFamily: 'monospace' }}>{r.pincode}</td>
      <td style={{ padding: '.4rem .2rem', fontSize: '.85rem' }}>{r.city || '—'}</td>
      <td style={{ padding: '.4rem .2rem', fontSize: '.85rem', color: r.area ? 'inherit' : 'var(--dim)' }}>
        {r.area || '—'}
      </td>
      <td style={{ padding: '.4rem .2rem', fontSize: '.85rem', color: 'var(--dim)' }}>{r.state || '—'}</td>
      <td style={{ padding: '.4rem .2rem' }}>
        <span style={{ display: 'inline-flex', gap: '.4rem', alignItems: 'center' }}>
          <Toggle
            checked={!!r.enabled}
            disabled={p.rowBusy === r.pincode}
            onChange={() => p.handleToggle(r.pincode, !!r.enabled)}
          />
          <span
            style={{
              fontSize: '.75rem',
              color: r.enabled ? 'var(--gb-wa-500)' : 'var(--gb-red-500)',
              fontWeight: 500,
            }}
          >
            {r.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </span>
      </td>
      <td style={{ padding: '.4rem .2rem', fontSize: '.8rem', color: 'var(--dim)' }}>
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
        <div className="cb"><p style={{ color: 'var(--dim)' }}>No city data yet. Import pincodes to get started.</p></div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
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
        className="ch"
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}
        onClick={onToggle}
      >
        <span style={{ fontSize: '.9rem' }}>{isOpen ? '▾' : '▸'}</span>
        <h3 style={{ margin: 0 }}>{bucket.state}</h3>
        <span style={{ fontSize: '.75rem', color: 'var(--dim)' }}>
          {bucket.cities.length} {bucket.cities.length === 1 ? 'city' : 'cities'} • {fmtNum(bucket.total)} pincodes
        </span>
        <span
          style={{
            fontSize: '.75rem',
            color: 'var(--gb-wa-500)',
            fontWeight: 500,
            marginLeft: '.4rem',
          }}
        >
          {fmtNum(bucket.enabled)} enabled
        </span>
        <span style={{ fontSize: '.75rem', color: 'var(--gb-red-500)', fontWeight: 500 }}>
          {fmtNum(bucket.disabled)} disabled
        </span>
        <div
          style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem', alignItems: 'center' }}
          onClick={(e) => e.stopPropagation()}
        >
          {stateConfirm ? (
            <>
              <span style={{ fontSize: '.75rem', color: 'var(--dim)' }}>
                {stateConfirm.enabled ? 'Enable' : 'Disable'} all {bucket.cities.length} cities?
              </span>
              <button
                className="btn-sm"
                style={{ background: stateConfirm.enabled ? 'var(--gb-wa-500)' : 'var(--gb-red-500)', color: 'var(--gb-neutral-0)' }}
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
        <div className="cb" style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
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
    <div
      style={{
        border: '1px solid var(--bd)',
        borderRadius: 6,
        padding: '.6rem .7rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '.5rem',
        background: 'var(--bg2, transparent)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
        <strong>{row.city}</strong>
        <span style={{ fontSize: '.75rem', color: 'var(--dim)' }}>
          {fmtNum(row.enabled)} / {fmtNum(row.total)} enabled
        </span>
        <span style={{ fontSize: '.7rem', color: 'var(--dim)' }}>({pct}%)</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {confirm ? (
            <>
              <span style={{ fontSize: '.7rem', color: 'var(--dim)' }}>
                {confirm.enabled ? 'Enable' : 'Disable'} {fmtNum(row.total)}?
              </span>
              <button
                className="btn-sm"
                style={{ background: confirm.enabled ? 'var(--gb-wa-500)' : 'var(--gb-red-500)', color: 'var(--gb-neutral-0)' }}
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
        <div
          style={{
            borderTop: '1px dashed var(--bd)',
            paddingTop: '.5rem',
            marginTop: '.2rem',
          }}
        >
          {pinsLoading && !pins ? (
            <p style={{ fontSize: '.8rem', color: 'var(--dim)' }}>Loading pincodes…</p>
          ) : !pins || !pins.length ? (
            <p style={{ fontSize: '.8rem', color: 'var(--dim)' }}>No pincodes in this city.</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem' }}>
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
      style={{
        fontFamily: 'monospace',
        fontSize: '.8rem',
        padding: '.25rem .5rem',
        borderRadius: 4,
        border: `1px solid ${enabled ? 'var(--gb-wa-500)' : 'var(--gb-red-500)'}`,
        background: enabled ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)',
        color: enabled ? 'var(--gb-wa-500)' : 'var(--gb-red-500)',
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {pincode}
    </button>
  );
}

interface ProgressBarProps { pct: number }

function ProgressBar({ pct }: ProgressBarProps) {
  return (
    <div
      style={{
        height: 6,
        background: 'rgba(220,38,38,0.15)',
        borderRadius: 3,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: 'var(--gb-wa-500)',
          transition: 'width .25s ease',
        }}
      />
    </div>
  );
}

interface StatBlockProps { label: string; value: string; color: string }

function StatBlock({ label, value, color }: StatBlockProps) {
  const labelStyle: CSSProperties = { fontSize: '.75rem', color: 'var(--dim)', marginBottom: '.2rem' };
  const valStyle: CSSProperties = { fontSize: '1.6rem', fontWeight: 600, color };
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={valStyle}>{value}</div>
    </div>
  );
}
