'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import * as XLSX from 'xlsx';
import { useToast } from '../../Toast';
import {
  uploadMenuCsv,
  uploadMultiBranchMenuCsv,
  uploadMenuXlsx,
  getMenuMapping,
  importMenu,
  syncCatalog,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

interface MenuFieldDef {
  key: string;
  label: string;
  required: boolean;
  aliases: string[];
}

const MENU_FIELDS: ReadonlyArray<MenuFieldDef> = [
  { key: 'name', label: 'Item Name', required: true, aliases: ['name', 'item', 'item_name', 'product', 'dish', 'food', 'title', 'menu_item'] },
  { key: 'price', label: 'Price (₹)', required: true, aliases: ['price', 'rate', 'mrp', 'cost', 'amount', 'selling_price', 'sp', 'rs', 'inr'] },
  { key: 'category', label: 'Category', required: false, aliases: ['category', 'cat', 'section', 'group', 'type', 'menu_section', 'course'] },
  { key: 'description', label: 'Description', required: false, aliases: ['description', 'desc', 'details', 'about', 'info', 'note', 'notes'] },
  { key: 'food_type', label: 'Food Type (veg/non_veg)', required: false, aliases: ['food_type', 'type', 'veg_nonveg', 'veg', 'nonveg', 'diet', 'food_category', 'is_veg', 'veg/non-veg'] },
  { key: 'image_url', label: 'Image URL', required: false, aliases: ['image_url', 'image', 'img', 'photo', 'picture', 'url', 'photo_url', 'image_link'] },
  { key: 'is_bestseller', label: 'Bestseller', required: false, aliases: ['is_bestseller', 'bestseller', 'popular', 'featured', 'hot', 'recommended', 'best', 'top'] },
  { key: 'size', label: 'Size / Portion', required: false, aliases: ['size', 'portion', 'variant', 'option', 'variant_value', 'size_name'] },
  { key: 'branch', label: 'Branch / Outlet', required: false, aliases: ['branch', 'outlet', 'location', 'branch_name', 'outlet_name', 'store', 'store_name'] },
];

const BRANCH_ALIASES: ReadonlyArray<string> = ['branch', 'outlet', 'location', 'branch_name', 'outlet_name', 'store', 'store_name'];

function autoMatch(headerRaw: string): string {
  const h = (headerRaw || '').toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  for (const f of MENU_FIELDS) if (f.aliases.includes(h)) return f.key;
  for (const f of MENU_FIELDS) if (f.aliases.some((a) => h.includes(a) || a.includes(h))) return f.key;
  return '__skip__';
}

function splitCSVLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i += 1; } else inQ = !inQ;
    } else if (c === ',' && !inQ) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

type ParsedRow = Record<string, string>;

interface ParsedFile {
  headers: string[];
  rows: ParsedRow[];
}

function parseRawCSV(text: string): ParsedFile {
  const lines = text.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) throw new Error('Need a header row and at least one data row');
  const headers = splitCSVLine(lines[0] || '');
  const rows = lines.slice(1).filter((l) => l.trim()).map((line) => {
    const vals = splitCSVLine(line);
    const obj: ParsedRow = {};
    headers.forEach((_, i) => { obj[i] = vals[i] ?? ''; });
    return obj;
  });
  return { headers, rows };
}

function parseFile(file: File): Promise<ParsedFile> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const buf = e.target?.result as ArrayBuffer;
          const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
          const sheetName = wb.SheetNames[0];
          if (!sheetName) throw new Error('Workbook has no sheets');
          const ws = wb.Sheets[sheetName];
          if (!ws) throw new Error('Workbook has no sheets');
          const data = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
          if (!data.length || data.length < 2) throw new Error('Need a header row and at least one data row');
          const firstRow = data[0] || [];
          const headers = firstRow.map((h) => String(h || '').trim()).filter((h) => h);
          const cc = headers.length;
          const rows = data.slice(1)
            .filter((r) => r.slice(0, cc).some((c) => String(c).trim() !== ''))
            .map((r) => {
              const obj: ParsedRow = {};
              headers.forEach((_, i) => { obj[i] = String(r[i] ?? '').trim(); });
              return obj;
            });
          if (!rows.length) throw new Error('No data rows found');
          resolve({ headers, rows });
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsArrayBuffer(file);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try { resolve(parseRawCSV(String(e.target?.result || ''))); } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsText(file);
  });
}

type Mapping = Record<string, string>;

function applyMapping(rows: ParsedRow[], mapping: Mapping): ParsedRow[] {
  return rows.map((row) => {
    const out: ParsedRow = {};
    Object.entries(mapping).forEach(([idx, fieldKey]) => {
      if (fieldKey && fieldKey !== '__skip__') out[fieldKey] = row[idx] ?? '';
    });
    return out;
  });
}

function downloadSample() {
  const sample = [
    'name,price,category,branch,food_type,size,description,is_bestseller,image_url',
    'Chicken Biryani,320,Biryani,Koramangala,non_veg,Full,Aromatic dum biryani,yes,',
    'Chicken Biryani,180,Biryani,Koramangala,non_veg,Half,Aromatic dum biryani,,',
    'Paneer Tikka,280,Starters,Koramangala,veg,,Grilled cottage cheese,yes,',
    'Butter Naan,45,Breads,Koramangala,veg,,Soft tandoor naan,,',
    'Chicken Biryani,350,Biryani,Indiranagar,non_veg,Full,Aromatic dum biryani,yes,',
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([sample], { type: 'text/csv' }));
  a.download = 'gullybite-menu-sample.csv';
  a.click();
}

interface UploadResult {
  added?: number;
  skipped?: number;
  errors?: string[];
}

interface SyncResult {
  totalSynced?: number;
  totalFailed?: number;
}

interface XlsxUploadResult {
  upload_id: string;
}

interface MappingResponse {
  detected_headers?: string[];
  column_mapping?: Mapping;
  sample_rows?: Array<Record<string, unknown>>;
}

interface ImportResult {
  total?: number;
  inserted?: number;
  skipped?: number;
  ready?: number;
  incomplete?: number;
}

interface CsvImportSectionProps {
  branches: Branch[];
  selectedBranchId: string;
  setSelectedBranchId: (id: string) => void;
}

type WizardStep = 'upload' | 'map' | 'done';

export default function CsvImportSection({ branches, selectedBranchId, setSelectedBranchId }: CsvImportSectionProps) {
  const { showToast } = useToast();
  const [mode, setMode] = useState<'inline' | 'xlsx'>('inline');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Inline mapper state
  const [raw, setRaw] = useState<ParsedFile | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [mapping, setMapping] = useState<Mapping>({});
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [multiBranch, setMultiBranch] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  // Wizard state
  const [wStep, setWStep] = useState<WizardStep>('upload');
  const [wFile, setWFile] = useState<File | null>(null);
  const [wUploading, setWUploading] = useState<boolean>(false);
  const [wUploadId, setWUploadId] = useState<string | null>(null);
  const [wHeaders, setWHeaders] = useState<string[]>([]);
  const [, setWAutoMapping] = useState<Mapping>({});
  const [wOverrides, setWOverrides] = useState<Mapping>({});
  const [wSample, setWSample] = useState<Array<Record<string, unknown>>>([]);
  const [wImporting, setWImporting] = useState<boolean>(false);
  const [wResult, setWResult] = useState<ImportResult | null>(null);

  const resetInline = () => {
    setRaw(null); setFileName(''); setMapping({}); setParsed([]);
    setMultiBranch(false); setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    try {
      const data = await parseFile(file);
      setRaw(data);
      const detected = data.headers.some((h) => BRANCH_ALIASES.includes((h || '').toLowerCase().trim()));
      setMultiBranch(detected);
      const m: Mapping = {};
      data.headers.forEach((h, i) => { m[i] = autoMatch(h); });
      setMapping(m);
      setParsed(applyMapping(data.rows, m));
    } catch (err: unknown) {
      const e2 = err as { message?: string };
      showToast('Could not parse file: ' + (e2?.message || 'unknown'), 'error');
      resetInline();
    }
  };

  const updateMapping = (i: number, value: string) => {
    setMapping((prev) => {
      const next: Mapping = { ...prev, [i]: value };
      if (raw) setParsed(applyMapping(raw.rows, next));
      return next;
    });
  };

  // True when the user has mapped a column to the 'branch' field — either
  // via auto-detect on file load (which also sets multiBranch) OR via a
  // manual mapping change on a column whose original header didn't match
  // BRANCH_ALIASES. Reactive — flips immediately when mapping changes.
  const branchColumnMapped = Object.values(mapping).includes('branch');
  const useMultiBranchPath = multiBranch || branchColumnMapped;
  const canUpload = parsed.length > 0;

  const handleUpload = async () => {
    if (!parsed.length) {
      showToast('No rows to upload', 'error');
      return;
    }
    if (!useMultiBranchPath && (!selectedBranchId || selectedBranchId.startsWith('__'))) {
      showToast('No branch selected — items will be assigned to the first branch or Unassigned', 'warning');
    }
    setUploading(true);
    setResult(null);
    try {
      const r = (useMultiBranchPath
        ? await uploadMultiBranchMenuCsv({ items: parsed, branchId: selectedBranchId })
        : await uploadMenuCsv(selectedBranchId, parsed)) as UploadResult;
      setResult(r);
      showToast(`✅ ${r.added || 0} items uploaded`, 'success');
      resetInline();
      try {
        const s = (await syncCatalog()) as SyncResult;
        if (s.totalFailed) showToast(`Menu saved but ${s.totalFailed} items failed to sync`, 'error');
        else showToast(`✅ ${s.totalSynced || 0} items live on WhatsApp!`, 'success');
      } catch (se: unknown) {
        const e = se as { message?: string };
        showToast('Menu saved but sync failed: ' + (e?.message || ''), 'error');
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  // ── Wizard flow ───────────────────────────────────────────────
  const resetWizard = () => {
    setWStep('upload'); setWFile(null); setWUploadId(null);
    setWHeaders([]); setWAutoMapping({}); setWOverrides({});
    setWSample([]); setWResult(null);
  };

  const handleWFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) {
      showToast('Only .xlsx is accepted for the server wizard', 'error');
      return;
    }
    setWFile(f);
  };

  const doWUpload = async () => {
    if (!wFile) return showToast('Pick an .xlsx file first', 'error');
    setWUploading(true);
    try {
      const d = (await uploadMenuXlsx(wFile)) as XlsxUploadResult;
      setWUploadId(d.upload_id);
      const mp = (await getMenuMapping(d.upload_id)) as MappingResponse;
      setWHeaders(mp.detected_headers || []);
      setWAutoMapping(mp.column_mapping || {});
      setWOverrides(mp.column_mapping || {});
      setWSample(mp.sample_rows || []);
      setWStep('map');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Upload failed', 'error');
    } finally {
      setWUploading(false);
    }
  };

  const doWImport = async () => {
    if (!wUploadId) return showToast('Upload first', 'error');
    setWImporting(true);
    try {
      const r = (await importMenu(wUploadId, wOverrides)) as ImportResult;
      setWResult(r);
      setWStep('done');
      showToast('Import complete', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Import failed', 'error');
    } finally {
      setWImporting(false);
    }
  };

  const wTargetFields: ReadonlyArray<string> = ['name', 'price', 'category', 'description', 'image', 'food_type', 'tax', 'availability'];

  return (
    <div>
      <div style={{ display: 'flex', gap: '.35rem', marginBottom: '.9rem' }}>
        <button
          type="button"
          className={mode === 'inline' ? 'chip on' : 'chip'}
          onClick={() => setMode('inline')}
        >
          📋 Inline CSV/XLSX mapper
        </button>
        <button
          type="button"
          className={mode === 'xlsx' ? 'chip on' : 'chip'}
          onClick={() => setMode('xlsx')}
        >
          🧙 Server XLSX wizard
        </button>
      </div>

      {mode === 'inline' && (
        <div className="card">
          <div className="ch" style={{ justifyContent: 'space-between' }}>
            <h3>📋 Menu import — CSV / XLSX</h3>
            <button type="button" className="btn-g btn-sm" onClick={downloadSample}>⬇ Sample CSV</button>
          </div>
          <div className="cb">
            <p style={{ fontSize: '.84rem', color: 'var(--dim)', marginBottom: '.6rem', lineHeight: 1.5 }}>
              Drop a file or pick one to map columns and preview rows. Include a <strong>branch</strong>
              column to split rows across branches — otherwise items are added to the branch you
              pick below.
            </p>

            {!multiBranch && (
              <div style={{ marginBottom: '.6rem' }}>
                <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
                  <label style={{ fontSize: '.82rem', color: 'var(--dim)' }}>Target branch:</label>
                  <select
                    value={selectedBranchId}
                    onChange={(e) => setSelectedBranchId(e.target.value)}
                    style={{ padding: '.4rem .6rem', borderRadius: 7, border: '1px solid var(--rim)', fontSize: '.85rem' }}
                  >
                    <option value="">{branchColumnMapped ? 'Auto (from file)' : 'Select…'}</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div style={{ fontSize: '.74rem', color: 'var(--dim)', marginTop: '.3rem' }}>
                  {branchColumnMapped
                    ? 'Items will be routed by branch name from the file. Select a branch only to override.'
                    : 'Optional — select a branch, or map a Branch Name column above. Items without a branch match go to Unassigned.'}
                </div>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFile}
              style={{ marginBottom: '.7rem' }}
            />

            {raw && (
              <>
                <p style={{ fontSize: '.82rem', color: 'var(--dim)', marginBottom: '.5rem' }}>
                  <strong>{fileName}</strong> · {raw.rows.length} rows
                  {multiBranch && ' · 🏪 Branch column detected — items will be routed automatically'}
                </p>

                <h4 style={{ fontSize: '.84rem', margin: '.5rem 0' }}>🗂️ Map columns</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '.4rem', marginBottom: '.7rem' }}>
                  {raw.headers.map((h, i) => (
                    <div key={i} style={{ display: 'contents' }}>
                      <div style={{ fontSize: '.8rem', padding: '.35rem .5rem', background: 'var(--ink2,#f4f4f5)', borderRadius: 6 }}>{h || '(empty)'}</div>
                      <div style={{ alignSelf: 'center', color: 'var(--dim)' }}>→</div>
                      <select
                        value={mapping[i] || '__skip__'}
                        onChange={(e) => updateMapping(i, e.target.value)}
                        style={{ padding: '.35rem .5rem', borderRadius: 6, border: '1px solid var(--rim)', fontSize: '.82rem' }}
                      >
                        <option value="__skip__">(skip this column)</option>
                        {MENU_FIELDS.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}{f.required ? ' ★' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>

                <h4 style={{ fontSize: '.84rem', margin: '.6rem 0 .3rem' }}>Preview (first 8 rows)</h4>
                <div style={{ overflowX: 'auto', marginBottom: '.7rem' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.8rem' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '.3rem', color: 'var(--dim)' }}>#</th>
                        {multiBranch && <th style={{ textAlign: 'left', padding: '.3rem', color: 'var(--dim)' }}>🏪</th>}
                        <th style={{ textAlign: 'left', padding: '.3rem', color: 'var(--dim)' }}>Name</th>
                        <th style={{ textAlign: 'left', padding: '.3rem', color: 'var(--dim)' }}>Category</th>
                        <th style={{ textAlign: 'left', padding: '.3rem', color: 'var(--dim)' }}>Price</th>
                        <th style={{ textAlign: 'left', padding: '.3rem', color: 'var(--dim)' }}>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.slice(0, 8).map((r, i) => (
                        <tr key={i}>
                          <td style={{ color: 'var(--dim)', padding: '.25rem .3rem' }}>{i + 1}</td>
                          {multiBranch && <td style={{ color: 'var(--wa)', padding: '.25rem .3rem' }}>{r.branch || r.outlet || r.location || '—'}</td>}
                          <td style={{ padding: '.25rem .3rem' }}>{r.name || <span style={{ color: '#dc2626' }}>missing</span>}</td>
                          <td style={{ padding: '.25rem .3rem' }}>{r.category || '—'}</td>
                          <td style={{ padding: '.25rem .3rem' }}>{r.price ? `₹${r.price}` : <span style={{ color: '#dc2626' }}>missing</span>}</td>
                          <td style={{ padding: '.25rem .3rem' }}>{r.food_type || 'veg'}</td>
                        </tr>
                      ))}
                      {parsed.length > 8 && (
                        <tr><td colSpan={multiBranch ? 6 : 5} style={{ textAlign: 'center', color: 'var(--dim)', padding: '.3rem' }}>+ {parsed.length - 8} more rows…</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div style={{ display: 'flex', gap: '.5rem' }}>
                  <button type="button" className="btn-p" onClick={handleUpload} disabled={uploading || !canUpload}>
                    {uploading ? 'Uploading…' : '⬆ Upload & Sync'}
                  </button>
                  <button type="button" className="btn-g" onClick={resetInline} disabled={uploading}>Reset</button>
                </div>
              </>
            )}

            {result && (
              <div
                style={{
                  marginTop: '.8rem', padding: '.7rem', background: '#ecfccb',
                  border: '1px solid #bef264', borderRadius: 8, fontSize: '.82rem',
                }}
              >
                ✅ <strong>{result.added || 0}</strong> items added/updated
                {result.skipped ? <> · ⚠️ <strong>{result.skipped}</strong> skipped</> : null}
                {result.errors?.length ? (
                  <div style={{ marginTop: '.5rem', color: '#991b1b', fontSize: '.76rem' }}>
                    {result.errors.slice(0, 5).join(' · ')}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}

      {mode === 'xlsx' && (
        <div className="card">
          <div className="ch"><h3>🧙 XLSX Import Wizard</h3></div>
          <div className="cb">
            <p style={{ fontSize: '.84rem', color: 'var(--dim)', marginBottom: '.7rem' }}>
              Uploads your .xlsx to the server, which auto-maps columns. Good for bigger files.
              New products land in <strong>Unassigned</strong> — assign them to a branch in the
              Menu Editor after import.
            </p>
            <div style={{ display: 'flex', gap: '.35rem', marginBottom: '.7rem' }}>
              {(['upload', 'map', 'done'] as const).map((step, i) => (
                <span
                  key={step}
                  style={{
                    padding: '.25rem .6rem', borderRadius: 99, fontSize: '.72rem',
                    background: wStep === step ? '#4f46e5' : 'var(--ink2,#f4f4f5)',
                    color: wStep === step ? '#fff' : 'var(--dim)',
                    fontWeight: 600,
                  }}
                >
                  {i + 1}. {step}
                </span>
              ))}
            </div>

            {wStep === 'upload' && (
              <div>
                <input type="file" accept=".xlsx" onChange={handleWFile} />
                <div style={{ marginTop: '.7rem', display: 'flex', gap: '.5rem' }}>
                  <button type="button" className="btn-p" onClick={doWUpload} disabled={wUploading || !wFile}>
                    {wUploading ? 'Uploading…' : 'Upload & preview'}
                  </button>
                </div>
              </div>
            )}

            {wStep === 'map' && (
              <div>
                <h4 style={{ fontSize: '.84rem', margin: '.3rem 0 .5rem' }}>Review mapping</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '.4rem .6rem', marginBottom: '.7rem' }}>
                  {wTargetFields.map((f) => (
                    <div key={f} style={{ display: 'contents' }}>
                      <label style={{ fontWeight: 600, fontSize: '.82rem', alignSelf: 'center', textTransform: 'capitalize' }}>
                        {f.replace('_', ' ')}
                      </label>
                      <select
                        value={wOverrides[f] || ''}
                        onChange={(e) => setWOverrides((o) => ({ ...o, [f]: e.target.value }))}
                        style={{ padding: '.35rem .5rem', borderRadius: 6, border: '1px solid var(--rim)', fontSize: '.82rem' }}
                      >
                        <option value="">— none —</option>
                        {wHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>

                {wSample.length > 0 && (
                  <>
                    <h4 style={{ fontSize: '.84rem', margin: '.5rem 0 .3rem' }}>Sample rows</h4>
                    <div style={{ overflowX: 'auto', marginBottom: '.7rem', border: '1px solid var(--rim)', borderRadius: 6 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.78rem' }}>
                        <thead>
                          <tr style={{ background: '#f3f4f6' }}>
                            {wHeaders.map((h) => <th key={h} style={{ textAlign: 'left', padding: '.3rem .5rem' }}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {wSample.slice(0, 8).map((r, i) => (
                            <tr key={i}>
                              {wHeaders.map((h) => (
                                <td key={h} style={{ padding: '.25rem .5rem', borderTop: '1px solid #f1f5f9' }}>
                                  {r[h] == null ? '' : String(r[h])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                <div style={{ display: 'flex', gap: '.5rem' }}>
                  <button type="button" className="btn-p" onClick={doWImport} disabled={wImporting}>
                    {wImporting ? 'Importing…' : 'Import products'}
                  </button>
                  <button type="button" className="btn-g" onClick={resetWizard} disabled={wImporting}>Start over</button>
                </div>
              </div>
            )}

            {wStep === 'done' && wResult && (
              <div>
                <div style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '.4rem' }}>✅ Import complete</div>
                <div>Total rows: <strong>{wResult.total}</strong></div>
                <div>Inserted: <strong style={{ color: '#059669' }}>{wResult.inserted}</strong></div>
                <div>Skipped: <strong style={{ color: '#b45309' }}>{wResult.skipped}</strong></div>
                <div style={{ fontSize: '.82rem', color: 'var(--dim)', marginTop: '.4rem' }}>
                  Ready: {wResult.ready} · Incomplete (Meta): {wResult.incomplete}
                </div>
                <div style={{ fontSize: '.78rem', color: 'var(--dim)', marginTop: '.5rem' }}>
                  New products start as <strong>Unassigned</strong>. Assign them to a branch to
                  make them visible.
                </div>
                <button type="button" className="btn-g btn-sm" style={{ marginTop: '.6rem' }} onClick={resetWizard}>
                  Start another import
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
