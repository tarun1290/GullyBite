'use client';

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../Toast';
import Toggle from '../Toggle';
import BranchFormModal from './BranchFormModal';
import BranchHoursEditor from './BranchHoursEditor';
import BranchMenuSection from './BranchMenuSection';
import {
  getBranches,
  updateBranch,
  importBranchesCsv,
  softDeleteBranch,
  restoreBranch,
  permanentDeleteBranch,
  retryBranchBilling,
} from '../../api/restaurant';
import type { Branch, BranchHours, BranchHoursDay } from '../../types';

interface BranchExt extends Branch {
  fssai_number?: string;
  manager_phone?: string;
  base_prep_time_min?: number;
  avg_item_prep_min?: number;
  is_open?: boolean;
  accepts_orders?: boolean;
  operating_hours?: BranchHours;
}

interface CsvRow {
  branch_name?: string;
  address?: string;
  city?: string;
  latitude?: string;
  longitude?: string;
  opening_time?: string;
  closing_time?: string;
  manager_phone?: string;
  [k: string]: string | undefined;
}

interface CsvFailure { name: string; reason: string }

interface CsvResult {
  created: number;
  errors?: number | string;
  details?: unknown;
  geocodeFailed: CsvFailure[];
}

interface CsvImportResponse {
  created?: number;
  errors?: number;
  details?: unknown;
}

const GEOCODE_DELAY_MS = 1100;
const DAY_NAMES_LIST = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

function formatHoursSummary(b: BranchExt): string {
  const oh = b.operating_hours;
  if (!oh) return `${(b.opening_time || '10:00').slice(0, 5)} – ${(b.closing_time || '22:00').slice(0, 5)}`;
  const openDays = DAY_NAMES_LIST.filter((d) => !oh[d]?.is_closed);
  if (!openDays.length) return 'Closed all days';
  const firstDay = openDays[0];
  if (!firstDay) return 'Closed all days';
  const first = oh[firstDay] as BranchHoursDay;
  const allSame = openDays.every((d) => {
    const dh = oh[d] as BranchHoursDay | undefined;
    return dh && dh.open === first.open && dh.close === first.close;
  });
  const t = `${first.open} – ${first.close}`;
  if (openDays.length === 7 && allSame) return t;
  if (allSame) {
    const closed = 7 - openDays.length;
    return `${t} (${closed} day${closed > 1 ? 's' : ''} closed)`;
  }
  return 'Custom schedule';
}

interface NominatimRow { lat?: string; lon?: string }

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number }> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&countrycodes=in&limit=1`,
    { headers: { 'Accept-Language': 'en' } },
  );
  const data = (await res.json()) as NominatimRow[];
  if (!data.length) throw new Error(`Address not found: "${address}"`);
  const first = data[0];
  if (!first) throw new Error(`Address not found: "${address}"`);
  return { lat: parseFloat(first.lat || '0'), lng: parseFloat(first.lon || '0') };
}

function simpleCsvParse(text: string): { headers: string[]; rows: CsvRow[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line: string): string[] => {
    const out: string[] = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
      } else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const firstLine = lines[0] || '';
  const headers = split(firstLine).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const rows = lines.slice(1).map((l) => {
    const vals = split(l);
    const obj: CsvRow = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
  return { headers, rows };
}

function toSnake(camel: string): string {
  return camel.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
}

export default function BranchesSection() {
  const { showToast } = useToast();
  const [branches, setBranches] = useState<BranchExt[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editingBranch, setEditingBranch] = useState<BranchExt | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<BranchExt | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [permanentDeletingId, setPermanentDeletingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedPane, setExpandedPane] = useState<'hours' | 'menu'>('hours');
  const [savingField, setSavingField] = useState<string | null>(null);
  // Tracks which branch's ID was just copied — drives the transient
  // "Copied!" → "Copy" label flip per card. Single string is enough
  // since at most one card's button can have just been clicked.
  const [copiedBranchId, setCopiedBranchId] = useState<string | null>(null);
  // Tracks which branch's retry-payment call is in flight. Single string
  // is enough — at most one retry should be running at a time, and
  // disabling the button at the row level prevents double-clicks.
  const [retryingBranchId, setRetryingBranchId] = useState<string | null>(null);

  const openCreate = () => { setEditingBranch(null); setModalOpen(true); };
  const openEdit = (b: BranchExt) => { setEditingBranch(b); setModalOpen(true); };
  const closeModal = () => { setModalOpen(false); setEditingBranch(null); };

  const load = async () => {
    setLoading(true);
    try {
      const list = (await getBranches()) as BranchExt[] | null;
      setBranches(Array.isArray(list) ? list : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load branches', 'error');
    } finally {
      setLoading(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingBranch) return;
    const id = deletingBranch.id;
    setDeleting(true);
    try {
      await softDeleteBranch(id);
      if (expandedId === id) setExpandedId(null);
      setDeletingBranch(null);
      showToast('Branch deleted — can be restored from the list', 'success');
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleRestore = async (b: BranchExt) => {
    setRestoringId(b.id);
    try {
      await restoreBranch(b.id);
      showToast(`✅ "${b.name}" restored`, 'success');
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Restore failed', 'error');
    } finally {
      setRestoringId(null);
    }
  };

  // Manual retry for a paused branch. Charges the wallet and flips
  // subscription_status back to 'active'. Surfaces the server-side
  // structured error verbatim — `Insufficient wallet balance` is the
  // common one; merchants need to know to top up.
  const handleRetryBilling = async (b: BranchExt) => {
    if (retryingBranchId) return;
    setRetryingBranchId(b.id);
    try {
      await retryBranchBilling(b.id);
      showToast('Branch reactivated', 'success');
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const msg = e?.response?.data?.error || e?.message || 'Retry failed';
      showToast(msg, 'error');
    } finally {
      setRetryingBranchId(null);
    }
  };

  const handlePermanentDelete = async (b: BranchExt) => {
    const ok = window.confirm(
      `Permanently delete "${b.name}"? This will remove the branch and all its menu items from GullyBite and WhatsApp catalog. This cannot be undone.`
    );
    if (!ok) return;
    setPermanentDeletingId(b.id);
    try {
      await permanentDeleteBranch(b.id);
      setBranches((prev) => prev.filter((x) => x.id !== b.id));
      if (expandedId === b.id) setExpandedId(null);
      showToast('Branch permanently deleted', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Permanent delete failed', 'error');
    } finally {
      setPermanentDeletingId(null);
    }
  };

  const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
  const [csvBusy, setCsvBusy] = useState<boolean>(false);
  const [csvProgress, setCsvProgress] = useState<string>('');
  const [csvResult, setCsvResult] = useState<CsvResult | null>(null);
  const [csvShow, setCsvShow] = useState<boolean>(false);

  useEffect(() => {
    load();
  }, []);

  const patchField = async (id: string, field: string, value: unknown) => {
    setSavingField(`${id}:${field}`);
    setBranches((list) => list.map((b) => b.id === id ? { ...b, [toSnake(field)]: value } : b));
    try {
      await updateBranch(id, { [field]: value });
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
      load();
    } finally {
      setSavingField(null);
    }
  };

  const handleCsvFile = async (file: File | undefined) => {
    if (!file) return;
    setCsvResult(null);
    try {
      const text = await file.text();
      const parsed = simpleCsvParse(text);
      const rows = parsed.rows.filter((r) => (r.branch_name || '').trim() && (r.address || '').trim());
      if (!rows.length) {
        showToast('CSV must have at least one row with branch_name and address', 'error');
        return;
      }
      setCsvRows(rows);
    } catch (err: unknown) {
      const e = err as { message?: string };
      showToast('Could not parse CSV: ' + (e.message || ''), 'error');
    }
  };

  const handleCsvUpload = async () => {
    if (!csvRows.length) return;
    setCsvBusy(true);
    setCsvResult(null);

    const toGeocode = csvRows.filter((r) => !r.latitude || !r.longitude);
    const geocodeFailed: CsvFailure[] = [];
    const rowsCopy = csvRows.map((r) => ({ ...r }));

    for (let i = 0; i < toGeocode.length; i++) {
      setCsvProgress(`Geocoding ${i + 1}/${toGeocode.length}…`);
      const targetRow = toGeocode[i];
      if (!targetRow) continue;
      try {
        if (i > 0) await new Promise<void>((res) => setTimeout(res, GEOCODE_DELAY_MS));
        const { lat, lng } = await geocodeAddress(targetRow.address || '');
        const idx = rowsCopy.findIndex((r) => r === targetRow || (r.branch_name === targetRow.branch_name && r.address === targetRow.address));
        if (idx >= 0) {
          const row = rowsCopy[idx];
          if (row) {
            row.latitude = String(lat);
            row.longitude = String(lng);
          }
        }
      } catch (e: unknown) {
        const err = e as { message?: string };
        geocodeFailed.push({ name: targetRow.branch_name || '', reason: err.message || '' });
      }
    }

    const readyRows = rowsCopy.filter((r) => r.latitude && r.longitude);
    if (!readyRows.length) {
      setCsvResult({ created: 0, errors: 'All failed', geocodeFailed });
      setCsvBusy(false);
      setCsvProgress('');
      return;
    }

    setCsvProgress(`Creating ${readyRows.length} branch${readyRows.length > 1 ? 'es' : ''}…`);
    try {
      const r = (await importBranchesCsv(readyRows.map((row) => ({ ...row })))) as CsvImportResponse | null;
      setCsvResult({ created: r?.created || 0, errors: r?.errors, details: r?.details, geocodeFailed });
      if (r?.created) {
        showToast(`✅ ${r.created} branch${r.created !== 1 ? 'es' : ''} created!`, 'success');
        setCsvRows([]);
        load();
        setTimeout(load, 5000);
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'CSV upload failed', 'error');
    } finally {
      setCsvBusy(false);
      setCsvProgress('');
    }
  };

  const downloadSample = () => {
    const sample = [
      'branch_name,address,city,latitude,longitude,opening_time,closing_time,manager_phone',
      'Koramangala Outlet,"Shop 5, Forum Mall, Koramangala, Bangalore 560095",Bangalore,12.934533,77.612487,10:00,22:00,+919876543210',
      'Indiranagar Branch,"100 Feet Road, Indiranagar, Bangalore 560038",Bangalore,,,11:00,23:00,+919876543211',
      'HSR Layout,"Sector 2, HSR Layout, Bangalore 560102",Bangalore,,,10:00,22:00,',
    ].join('\n');
    const blob = new Blob([sample], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gullybite_outlets_sample.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const sortedBranches = useMemo(() => {
    const sortKey = (b: BranchExt) => {
      const t = b.updated_at || b.created_at || 0;
      const ms = new Date(t).getTime();
      return Number.isFinite(ms) ? ms : 0;
    };
    const active = branches.filter((b) => !b.deleted_at).sort((a, b) => sortKey(b) - sortKey(a));
    const deleted = branches.filter((b) => !!b.deleted_at).sort((a, b) => sortKey(b) - sortKey(a));
    return [...active, ...deleted];
  }, [branches]);

  return (
    <div>
      <div className="card mb-4">
        <div className="ch justify-between">
          <h3>🏪 Branches</h3>
          <div className="flex gap-[0.4rem]">
            <button
              type="button"
              className="btn-g btn-sm"
              onClick={() => setCsvShow((v) => !v)}
            >
              📋 CSV Import
            </button>
            <button
              type="button"
              className="btn-p btn-sm"
              onClick={openCreate}
            >
              + Add Branch
            </button>
          </div>
        </div>

        {csvShow && (
          <div className="cb border-t border-rim">
            <div className="mb-[0.55rem]">
              <h4 className="m-0 text-[0.9rem]">📋 Bulk Add Outlets via CSV</h4>
              <p className="text-[0.78rem] text-dim mt-[0.3rem]">
                Required columns: <code>branch_name</code>, <code>address</code>. Optional:{' '}
                <code>city</code>, <code>latitude</code>, <code>longitude</code>,{' '}
                <code>opening_time</code>, <code>closing_time</code>,{' '}
                <code>manager_phone</code>. Rows without coords will be geocoded at 1/sec.
              </p>
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <input
                type="file"
                accept=".csv"
                onChange={(e) => handleCsvFile(e.target.files?.[0])}
                className="text-[0.8rem]"
              />
              <button type="button" className="btn-g btn-sm" onClick={downloadSample}>
                ⬇ Download sample
              </button>
              {csvRows.length > 0 && (
                <button
                  type="button"
                  className="btn-p btn-sm"
                  onClick={handleCsvUpload}
                  disabled={csvBusy}
                >
                  {csvBusy ? csvProgress || 'Uploading…' : `📍 Create ${csvRows.length} Branches`}
                </button>
              )}
            </div>
            {csvRows.length > 0 && (
              <div className="mt-[0.6rem] p-2 bg-ink2 rounded-md max-h-[200px] overflow-y-auto">
                {csvRows.map((r, i) => (
                  <div key={`${r.branch_name}-${i}`} className="text-[0.78rem] py-[0.15rem]">
                    {i + 1}. <strong>{r.branch_name}</strong> — {r.address}{' '}
                    {(r.latitude && r.longitude) ? (
                      <span className="text-wa">✅ coords</span>
                    ) : (
                      <span className="text-dim">📍 will geocode</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {csvResult && (
              <div className="mt-[0.6rem] text-[0.8rem]">
                <div className="flex gap-[0.4rem] flex-wrap">
                  <span className="csv-result-ok bg-[#dcfce7] text-[#15803d] py-[0.2rem] px-[0.55rem] rounded-md">
                    ✅ <strong>{csvResult.created}</strong> created
                  </span>
                  {!!csvResult.geocodeFailed?.length && (
                    <span className="csv-result-warn bg-[#fef9c3] text-[#a16207] py-[0.2rem] px-[0.55rem] rounded-md">
                      ⚠️ <strong>{csvResult.geocodeFailed.length}</strong> geocoding failed
                    </span>
                  )}
                  {!!csvResult.errors && (
                    <span className="bg-[rgba(220,38,38,0.12)] text-red-600 py-[0.2rem] px-[0.55rem] rounded-md">
                      ❌ {csvResult.errors} failed
                    </span>
                  )}
                </div>
                {!!csvResult.geocodeFailed?.length && (
                  <div className="mt-[0.4rem] text-[0.72rem] text-red">
                    Geocoding failed: {csvResult.geocodeFailed.map((f) => `${f.name} (${f.reason})`).join(', ')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <p className="text-dim">Loading branches…</p>
      ) : !branches.length ? (
        <div className="empty text-center py-8">
          <div className="ei text-[2.5rem]">📍</div>
          <h3>No branches yet</h3>
          <p className="text-dim text-[0.84rem]">
            Add your first branch to unlock WhatsApp catalog sync.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-[0.7rem]">
          {sortedBranches.map((b) => {
            const isDeleted = !!b.deleted_at;
            const isExpanded = !isDeleted && expandedId === b.id;
            return (
              <div
                key={b.id}
                className={`bcard bg-surface border border-bdr rounded-[10px] overflow-hidden relative ${isDeleted ? 'opacity-55' : 'opacity-100'}`}
                id={`bc-${b.id}`}
              >
                {isDeleted && (
                  <span className="absolute top-2 right-[0.6rem] bg-[#fee2e2] text-[#b91c1c] text-[0.65rem] font-bold tracking-[0.04em] py-[0.15rem] px-2 rounded-sm z-1">
                    DELETED
                  </span>
                )}
                <div
                  className={`bcard-hd flex items-start gap-[0.7rem] py-3 px-[0.95rem] ${isDeleted ? 'cursor-default' : 'cursor-pointer'} ${isExpanded ? 'bg-ink2' : 'bg-transparent'}`}
                  onClick={isDeleted ? undefined : () => setExpandedId(isExpanded ? null : b.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="bcard-name font-bold text-[0.95rem]">
                      {b.name}
                    </div>
                    {/* Branch ID row — between name and address per spec.
                        Inline copy button briefly flips to "Copied!" via
                        copiedBranchId state, then reverts after 1.5s.
                        e.stopPropagation() on the click so the surrounding
                        row's setExpandedId toggle doesn't fire. */}
                    <div className="flex items-center gap-[0.4rem] mt-[0.15rem] text-[0.72rem] text-dim">
                      <span>Branch ID:</span>
                      <span className="font-mono text-dim text-[0.72rem] break-all">
                        #{b.id}
                      </span>
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await navigator.clipboard.writeText(b.id);
                            setCopiedBranchId(b.id);
                            setTimeout(() => {
                              setCopiedBranchId((cur) => (cur === b.id ? null : cur));
                            }, 1500);
                          } catch {
                            /* clipboard unavailable — silent no-op */
                          }
                        }}
                        aria-label="Copy branch ID"
                        className="bg-transparent border border-bdr text-dim text-[0.68rem] py-[0.05rem] px-[0.35rem] rounded-sm cursor-pointer leading-[1.4]"
                      >
                        {copiedBranchId === b.id ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <div className="bcard-addr text-[0.8rem] text-dim mt-[0.15rem]">
                      {b.address || b.city || '—'}
                    </div>
                  </div>
                  <div className="bcard-badges flex gap-1 flex-wrap justify-end items-center">
                    {b.subscription_status === 'paused' && (
                      <>
                        <span
                          className="bg-red-600 text-white text-[0.65rem] font-bold py-[0.15rem] px-[0.4rem] rounded-sm uppercase tracking-[0.04em]"
                          title="Subscription paused — wallet was insufficient on the last billing cycle"
                        >
                          ⚠ Paused
                        </span>
                        <button
                          type="button"
                          className="btn-p btn-sm text-[0.7rem] py-[0.15rem] px-2"
                          onClick={(e) => { e.stopPropagation(); handleRetryBilling(b); }}
                          disabled={retryingBranchId === b.id}
                        >
                          {retryingBranchId === b.id ? '…' : 'Retry Payment'}
                        </button>
                      </>
                    )}
                    <span className={`badge ${b.is_active === false ? 'br' : 'bg'} text-[0.65rem]`}>
                      {b.is_active === false ? '⏸ Inactive' : '✅ Active'}
                    </span>
                    <span className={`badge ${b.is_open ? 'bg' : 'br'} text-[0.65rem]`}>
                      {b.is_open ? '🟢 Open' : '🔴 Closed'}
                    </span>
                    <span className={`badge ${b.accepts_orders ? 'bg' : 'ba'} text-[0.65rem]`}>
                      {b.accepts_orders ? 'Taking Orders' : 'Paused'}
                    </span>
                    {b.fssai_number ? (
                      <span className="badge bg text-[0.65rem]" title="FSSAI on file">FSSAI ✓</span>
                    ) : (
                      <span className="badge ba text-[0.65rem]" title="FSSAI missing — sync will be blocked">FSSAI ✗</span>
                    )}
                    {b.gst_number && (
                      <span className="badge bg text-[0.65rem]" title={b.gst_number}>GST ✓</span>
                    )}
                    {!isDeleted && (
                      <span className="text-[0.85rem] text-dim ml-[0.4rem]">
                        {isExpanded ? '▾' : '▸'}
                      </span>
                    )}
                  </div>
                </div>

                {isDeleted && (
                  <div className="pt-[0.6rem] px-[0.95rem] pb-3 border-t border-bdr flex justify-end gap-[0.4rem]">
                    <button
                      type="button"
                      className="btn-g btn-sm opacity-100"
                      onClick={() => handleRestore(b)}
                      disabled={restoringId === b.id || permanentDeletingId === b.id}
                    >
                      {restoringId === b.id ? 'Restoring…' : '↺ Restore branch'}
                    </button>
                    <button
                      type="button"
                      className="btn-del btn-sm"
                      onClick={() => handlePermanentDelete(b)}
                      disabled={restoringId === b.id || permanentDeletingId === b.id}
                    >
                      {permanentDeletingId === b.id ? 'Deleting…' : '🗑 Permanently Delete'}
                    </button>
                  </div>
                )}

                {isExpanded && (
                  <div className="bcard-body p-[0.9rem]">
                    <div className="bcard-actions flex justify-end gap-[0.4rem] mb-[0.7rem]">
                      <button
                        type="button"
                        className="btn-g btn-sm"
                        onClick={(e) => { e.stopPropagation(); openEdit(b); }}
                        title="Edit all branch details (name, address, hours, FSSAI…)"
                      >
                        ✏️ Edit Branch
                      </button>
                      <button
                        type="button"
                        className="btn-del btn-sm"
                        onClick={(e) => { e.stopPropagation(); setDeletingBranch(b); }}
                        title="Soft-delete this branch (recoverable)"
                      >
                        🗑 Delete
                      </button>
                    </div>

                    <div className="ipair-row flex gap-4 flex-wrap mb-[0.7rem] text-[0.78rem]">
                      <div className="ipair">
                        <label className="text-dim mr-[0.3rem]">Hours</label>
                        <code>{formatHoursSummary(b)}</code>
                      </div>
                      <div className="ipair flex items-center gap-[0.3rem]">
                        <label className="text-dim">Base Prep</label>
                        <input
                          type="number" min={5} max={60}
                          value={b.base_prep_time_min ?? 15}
                          onChange={(e) => patchField(b.id, 'basePrepTimeMin', parseInt(e.target.value, 10))}
                          disabled={savingField === `${b.id}:basePrepTimeMin`}
                          className="w-14 py-[0.2rem] px-[0.4rem] border border-rim rounded-sm text-[0.78rem]"
                        /> min
                      </div>
                      <div className="ipair flex items-center gap-[0.3rem]">
                        <label className="text-dim">Per-Item</label>
                        <input
                          type="number" min={0} max={15}
                          value={b.avg_item_prep_min ?? 3}
                          onChange={(e) => patchField(b.id, 'avgItemPrepMin', parseInt(e.target.value, 10))}
                          disabled={savingField === `${b.id}:avgItemPrepMin`}
                          className="w-14 py-[0.2rem] px-[0.4rem] border border-rim rounded-sm text-[0.78rem]"
                        /> min
                      </div>
                      <div className="ipair flex items-center gap-[0.3rem]">
                        <label className="text-dim">Manager</label>
                        <input
                          type="text"
                          defaultValue={b.manager_phone || ''}
                          placeholder="+91…"
                          onBlur={(e) => {
                            if (e.target.value !== (b.manager_phone || '')) {
                              patchField(b.id, 'managerPhone', e.target.value);
                            }
                          }}
                          className="w-[140px] py-[0.2rem] px-[0.4rem] border border-rim rounded-sm text-[0.78rem]"
                        />
                      </div>
                    </div>

                    <div className="bcard-togs flex gap-4 flex-wrap mb-[0.9rem]">
                      <div className="tog flex items-center gap-[0.4rem]">
                        <Toggle
                          checked={!!b.accepts_orders}
                          onChange={(next) => patchField(b.id, 'acceptsOrders', next)}
                        />
                        <span className="text-[0.82rem]">Accepting orders</span>
                      </div>
                      <div className="tog flex items-center gap-[0.4rem]">
                        <Toggle
                          checked={!!b.is_open}
                          onChange={(next) => patchField(b.id, 'isOpen', next)}
                        />
                        <span className="text-[0.82rem]">Branch open</span>
                      </div>
                      <div className="tog flex items-center gap-[0.4rem]">
                        <Toggle
                          checked={b.is_active !== false}
                          onChange={(next) => patchField(b.id, 'isActive', next)}
                        />
                        <span className="text-[0.82rem]">
                          Active <small className="text-dim">(customer visibility)</small>
                        </span>
                      </div>
                    </div>

                    <div className="flex gap-[0.3rem] mb-[0.7rem] pb-[0.4rem] border-b border-rim">
                      <button
                        type="button"
                        className={expandedPane === 'hours' ? 'chip on' : 'chip'}
                        onClick={() => setExpandedPane('hours')}
                      >
                        🕐 Hours
                      </button>
                      <button
                        type="button"
                        className={expandedPane === 'menu' ? 'chip on' : 'chip'}
                        onClick={() => setExpandedPane('menu')}
                      >
                        🍽️ Menu & Catalog
                      </button>
                    </div>

                    {expandedPane === 'hours' && (
                      <BranchHoursEditor branchId={b.id} onSaved={load} />
                    )}
                    {expandedPane === 'menu' && (
                      <BranchMenuSection branch={b} onCatalogChange={load} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {deletingBranch && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delete branch"
          onClick={deleting ? undefined : () => setDeletingBranch(null)}
          className="fixed inset-0 bg-black/50 z-100 flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-surface rounded-[10px] max-w-[460px] w-full shadow-[0_12px_40px_rgba(0,0,0,0.18)] overflow-hidden"
          >
            <div className="ch justify-between">
              <h3 className="m-0">Delete this branch?</h3>
              <button
                type="button" className="btn-g btn-sm"
                onClick={() => setDeletingBranch(null)} disabled={deleting}
              >
                ✕
              </button>
            </div>
            <div className="cb">
              <div className="bg-[#fffbeb] border border-[#fde68a] rounded-md py-3 px-[0.85rem] text-[#92400e] text-[0.82rem] mb-[0.85rem]">
                <strong>{deletingBranch.name}</strong> will be hidden from the platform but can be restored later.
                Customers can no longer order from this branch.
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button" className="btn-g btn-sm"
                  onClick={() => setDeletingBranch(null)} disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmDelete}
                  disabled={deleting}
                  className="bg-red-600 text-white border-0 rounded-md py-[0.4rem] px-[0.9rem] text-[0.8rem] font-semibold cursor-pointer disabled:cursor-not-allowed"
                >
                  {deleting ? 'Deleting…' : 'Delete branch'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <BranchFormModal
        open={modalOpen}
        mode={editingBranch ? 'edit' : 'create'}
        existingBranch={editingBranch}
        onClose={closeModal}
        onSaved={() => {
          load();
          if (!editingBranch) {
            setTimeout(load, 3500);
            setTimeout(load, 7000);
          }
        }}
      />
    </div>
  );
}
