'use client';

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../Toast';
import Toggle from '../../Toggle';
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
} from '../../../api/restaurant';
import type { Branch, BranchHours, BranchHoursDay } from '../../../types';

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
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>🏪 Branches</h3>
          <div style={{ display: 'flex', gap: '.4rem' }}>
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
          <div className="cb" style={{ borderTop: '1px solid var(--rim)' }}>
            <div style={{ marginBottom: '.55rem' }}>
              <h4 style={{ margin: 0, fontSize: '.9rem' }}>📋 Bulk Add Outlets via CSV</h4>
              <p style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: '.3rem' }}>
                Required columns: <code>branch_name</code>, <code>address</code>. Optional:{' '}
                <code>city</code>, <code>latitude</code>, <code>longitude</code>,{' '}
                <code>opening_time</code>, <code>closing_time</code>,{' '}
                <code>manager_phone</code>. Rows without coords will be geocoded at 1/sec.
              </p>
            </div>
            <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="file"
                accept=".csv"
                onChange={(e) => handleCsvFile(e.target.files?.[0])}
                style={{ fontSize: '.8rem' }}
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
              <div
                style={{
                  marginTop: '.6rem', padding: '.5rem', background: 'var(--ink2,#f4f4f5)',
                  borderRadius: 6, maxHeight: 200, overflowY: 'auto',
                }}
              >
                {csvRows.map((r, i) => (
                  <div key={`${r.branch_name}-${i}`} style={{ fontSize: '.78rem', padding: '.15rem 0' }}>
                    {i + 1}. <strong>{r.branch_name}</strong> — {r.address}{' '}
                    {(r.latitude && r.longitude) ? (
                      <span style={{ color: 'var(--wa,#16a34a)' }}>✅ coords</span>
                    ) : (
                      <span style={{ color: 'var(--dim)' }}>📍 will geocode</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {csvResult && (
              <div style={{ marginTop: '.6rem', fontSize: '.8rem' }}>
                <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
                  <span className="csv-result-ok" style={{ background: '#dcfce7', color: '#15803d', padding: '.2rem .55rem', borderRadius: 6 }}>
                    ✅ <strong>{csvResult.created}</strong> created
                  </span>
                  {!!csvResult.geocodeFailed?.length && (
                    <span className="csv-result-warn" style={{ background: '#fef9c3', color: '#a16207', padding: '.2rem .55rem', borderRadius: 6 }}>
                      ⚠️ <strong>{csvResult.geocodeFailed.length}</strong> geocoding failed
                    </span>
                  )}
                  {!!csvResult.errors && (
                    <span style={{ background: 'rgba(220,38,38,.12)', color: '#dc2626', padding: '.2rem .55rem', borderRadius: 6 }}>
                      ❌ {csvResult.errors} failed
                    </span>
                  )}
                </div>
                {!!csvResult.geocodeFailed?.length && (
                  <div style={{ marginTop: '.4rem', fontSize: '.72rem', color: 'var(--red,#dc2626)' }}>
                    Geocoding failed: {csvResult.geocodeFailed.map((f) => `${f.name} (${f.reason})`).join(', ')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <p style={{ color: 'var(--dim)' }}>Loading branches…</p>
      ) : !branches.length ? (
        <div className="empty" style={{ textAlign: 'center', padding: '2rem 0' }}>
          <div className="ei" style={{ fontSize: '2.5rem' }}>📍</div>
          <h3>No branches yet</h3>
          <p style={{ color: 'var(--dim)', fontSize: '.84rem' }}>
            Add your first branch to unlock WhatsApp catalog sync.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.7rem' }}>
          {sortedBranches.map((b) => {
            const isDeleted = !!b.deleted_at;
            const isExpanded = !isDeleted && expandedId === b.id;
            return (
              <div
                key={b.id}
                className="bcard"
                id={`bc-${b.id}`}
                style={{
                  background: 'var(--surface,#fff)',
                  border: '1px solid var(--bdr,#e5e7eb)',
                  borderRadius: 10,
                  overflow: 'hidden',
                  opacity: isDeleted ? 0.55 : 1,
                  position: 'relative',
                }}
              >
                {isDeleted && (
                  <span
                    style={{
                      position: 'absolute', top: '.5rem', right: '.6rem',
                      background: '#fee2e2', color: '#b91c1c',
                      fontSize: '.65rem', fontWeight: 700, letterSpacing: '.04em',
                      padding: '.15rem .5rem', borderRadius: 4, zIndex: 1,
                    }}
                  >
                    DELETED
                  </span>
                )}
                <div
                  className="bcard-hd"
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: '.7rem',
                    padding: '.75rem .95rem',
                    cursor: isDeleted ? 'default' : 'pointer',
                    background: isExpanded ? 'var(--ink2,#f4f4f5)' : 'transparent',
                  }}
                  onClick={isDeleted ? undefined : () => setExpandedId(isExpanded ? null : b.id)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="bcard-name" style={{ fontWeight: 700, fontSize: '.95rem' }}>
                      {b.name}
                    </div>
                    <div className="bcard-addr" style={{ fontSize: '.8rem', color: 'var(--dim)', marginTop: '.15rem' }}>
                      {b.address || b.city || '—'}
                    </div>
                  </div>
                  <div className="bcard-badges" style={{ display: 'flex', gap: '.25rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span className={`badge ${b.is_active === false ? 'br' : 'bg'}`} style={{ fontSize: '.65rem' }}>
                      {b.is_active === false ? '⏸ Inactive' : '✅ Active'}
                    </span>
                    <span className={`badge ${b.is_open ? 'bg' : 'br'}`} style={{ fontSize: '.65rem' }}>
                      {b.is_open ? '🟢 Open' : '🔴 Closed'}
                    </span>
                    <span className={`badge ${b.accepts_orders ? 'bg' : 'ba'}`} style={{ fontSize: '.65rem' }}>
                      {b.accepts_orders ? 'Taking Orders' : 'Paused'}
                    </span>
                    {b.fssai_number ? (
                      <span className="badge bg" title="FSSAI on file" style={{ fontSize: '.65rem' }}>FSSAI ✓</span>
                    ) : (
                      <span className="badge ba" title="FSSAI missing — sync will be blocked" style={{ fontSize: '.65rem' }}>FSSAI ✗</span>
                    )}
                    {b.gst_number && (
                      <span className="badge bg" title={b.gst_number} style={{ fontSize: '.65rem' }}>GST ✓</span>
                    )}
                    {!isDeleted && (
                      <span style={{ fontSize: '.85rem', color: 'var(--dim)', marginLeft: '.4rem' }}>
                        {isExpanded ? '▾' : '▸'}
                      </span>
                    )}
                  </div>
                </div>

                {isDeleted && (
                  <div
                    style={{
                      padding: '.6rem .95rem .75rem',
                      borderTop: '1px solid var(--bdr,#e5e7eb)',
                      display: 'flex', justifyContent: 'flex-end', gap: '.4rem',
                    }}
                  >
                    <button
                      type="button"
                      className="btn-g btn-sm"
                      onClick={() => handleRestore(b)}
                      disabled={restoringId === b.id || permanentDeletingId === b.id}
                      style={{ opacity: 1 }}
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
                  <div className="bcard-body" style={{ padding: '.9rem' }}>
                    <div
                      className="bcard-actions"
                      style={{ display: 'flex', justifyContent: 'flex-end', gap: '.4rem', marginBottom: '.7rem' }}
                    >
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

                    <div
                      className="ipair-row"
                      style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '.7rem', fontSize: '.78rem' }}
                    >
                      <div className="ipair">
                        <label style={{ color: 'var(--dim)', marginRight: '.3rem' }}>Hours</label>
                        <code>{formatHoursSummary(b)}</code>
                      </div>
                      <div className="ipair" style={{ display: 'flex', alignItems: 'center', gap: '.3rem' }}>
                        <label style={{ color: 'var(--dim)' }}>Base Prep</label>
                        <input
                          type="number" min={5} max={60}
                          value={b.base_prep_time_min ?? 15}
                          onChange={(e) => patchField(b.id, 'basePrepTimeMin', parseInt(e.target.value, 10))}
                          disabled={savingField === `${b.id}:basePrepTimeMin`}
                          style={{ width: 56, padding: '.2rem .4rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.78rem' }}
                        /> min
                      </div>
                      <div className="ipair" style={{ display: 'flex', alignItems: 'center', gap: '.3rem' }}>
                        <label style={{ color: 'var(--dim)' }}>Per-Item</label>
                        <input
                          type="number" min={0} max={15}
                          value={b.avg_item_prep_min ?? 3}
                          onChange={(e) => patchField(b.id, 'avgItemPrepMin', parseInt(e.target.value, 10))}
                          disabled={savingField === `${b.id}:avgItemPrepMin`}
                          style={{ width: 56, padding: '.2rem .4rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.78rem' }}
                        /> min
                      </div>
                      <div className="ipair" style={{ display: 'flex', alignItems: 'center', gap: '.3rem' }}>
                        <label style={{ color: 'var(--dim)' }}>Manager</label>
                        <input
                          type="text"
                          defaultValue={b.manager_phone || ''}
                          placeholder="+91…"
                          onBlur={(e) => {
                            if (e.target.value !== (b.manager_phone || '')) {
                              patchField(b.id, 'managerPhone', e.target.value);
                            }
                          }}
                          style={{ width: 140, padding: '.2rem .4rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.78rem' }}
                        />
                      </div>
                    </div>

                    <div className="bcard-togs" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '.9rem' }}>
                      <div className="tog" style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                        <Toggle
                          checked={!!b.accepts_orders}
                          onChange={(next) => patchField(b.id, 'acceptsOrders', next)}
                        />
                        <span style={{ fontSize: '.82rem' }}>Accepting orders</span>
                      </div>
                      <div className="tog" style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                        <Toggle
                          checked={!!b.is_open}
                          onChange={(next) => patchField(b.id, 'isOpen', next)}
                        />
                        <span style={{ fontSize: '.82rem' }}>Branch open</span>
                      </div>
                      <div className="tog" style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                        <Toggle
                          checked={b.is_active !== false}
                          onChange={(next) => patchField(b.id, 'isActive', next)}
                        />
                        <span style={{ fontSize: '.82rem' }}>
                          Active <small style={{ color: 'var(--dim)' }}>(customer visibility)</small>
                        </span>
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex', gap: '.3rem', marginBottom: '.7rem',
                        paddingBottom: '.4rem', borderBottom: '1px solid var(--rim)',
                      }}
                    >
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
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface,#fff)', borderRadius: 10, maxWidth: 460, width: '100%',
              boxShadow: '0 12px 40px rgba(0,0,0,.18)', overflow: 'hidden',
            }}
          >
            <div className="ch" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>Delete this branch?</h3>
              <button
                type="button" className="btn-g btn-sm"
                onClick={() => setDeletingBranch(null)} disabled={deleting}
              >
                ✕
              </button>
            </div>
            <div className="cb">
              <div style={{
                background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6,
                padding: '.75rem .85rem', color: '#92400e', fontSize: '.82rem', marginBottom: '.85rem',
              }}
              >
                <strong>{deletingBranch.name}</strong> will be hidden from the platform but can be restored later.
                Customers can no longer order from this branch.
              </div>
              <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
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
                  style={{
                    background: '#dc2626', color: '#fff', border: 'none',
                    borderRadius: 6, padding: '.4rem .9rem', fontSize: '.8rem', fontWeight: 600,
                    cursor: deleting ? 'not-allowed' : 'pointer',
                  }}
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
