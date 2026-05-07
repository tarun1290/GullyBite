'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import * as XLSX from 'xlsx';
import { useToast } from '../../Toast';
import {
  uploadMenuCsv,
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

// Field aliases are deliberately conservative. Generic / overlapping
// tokens were stripped after Meta catalog exports were silently
// mis-mapping `title`, `item_group_id`, and `google_product_category`
// onto the Item Name field via fuzzy substring matches:
//   - 'food', 'item', 'product'  (name)            → collided with food_type / item_group_id / google_product_category
//   - 'group', 'type'            (category)        → collided with item_group_id / food_type
//   - 'type', 'veg'              (food_type)       → over-broad
//   - 'hot', 'top'               (is_bestseller)   → false positives ("hot dog", "top sirloin")
//   - 'url'                      (image_url)       → collided with link / external_url
const MENU_FIELDS: ReadonlyArray<MenuFieldDef> = [
  { key: 'name', label: 'Item Name', required: true, aliases: ['name', 'item_name', 'product_name', 'dish', 'title', 'menu_item'] },
  { key: 'price', label: 'Price (₹)', required: true, aliases: ['price', 'rate', 'mrp', 'cost', 'amount', 'selling_price', 'sp', 'rs', 'inr'] },
  { key: 'category', label: 'Category', required: false, aliases: ['category', 'cat', 'section', 'menu_section', 'course'] },
  { key: 'description', label: 'Description', required: false, aliases: ['description', 'desc', 'details', 'about', 'info', 'note', 'notes'] },
  { key: 'food_type', label: 'Food Type (veg/non_veg)', required: false, aliases: ['food_type', 'veg_nonveg', 'nonveg', 'diet', 'food_category', 'is_veg', 'veg/non-veg'] },
  { key: 'image_url', label: 'Image URL', required: false, aliases: ['image_url', 'image', 'img', 'photo', 'picture', 'photo_url', 'image_link'] },
  { key: 'is_bestseller', label: 'Bestseller', required: false, aliases: ['is_bestseller', 'bestseller', 'popular', 'featured', 'recommended', 'best'] },
  { key: 'size', label: 'Size / Portion', required: false, aliases: ['size', 'portion', 'variant', 'option', 'variant_value', 'size_name'] },
  { key: 'branch', label: 'Branch / Outlet', required: false, aliases: ['branch', 'outlet', 'location', 'branch_name', 'outlet_name', 'store', 'store_name'] },
];

const BRANCH_ALIASES: ReadonlyArray<string> = ['branch', 'outlet', 'location', 'branch_name', 'outlet_name', 'store', 'store_name'];

function normalizeHeader(headerRaw: string): string {
  return (headerRaw || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

// Two-pass auto-mapping. Pass 1 only takes EXACT alias matches and
// locks each target field to the first header that claims it, so
// a Meta export with both 'name' and 'product_name' picks one of
// them deterministically. Pass 2 then attempts token-level matches
// for headers still unassigned (e.g. 'food_type' splits on '_' to
// ['food', 'type'] — token equality, never substring containment).
// When multiple fields could token-match the same header, we prefer
// the field whose matching alias is longer (more specific).
//
// The substring-fuzzy path the old autoMatch() used was the source
// of the silent multi-mapping bug — it claimed 'google_product_category'
// for the Item Name field via the alias 'product'. Removing the
// generic aliases (see MENU_FIELDS comment) plus this stricter
// matcher eliminates the false positives.
function autoMatchAll(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const taken = new Set<string>(); // field.key values already locked
  const norms = headers.map(normalizeHeader);

  // PASS 1 — exact-match. Iterate fields so the spec's "first header
  // whose normalized value exactly equals one of the field's aliases"
  // is unambiguous: the first header (by index) wins.
  for (const f of MENU_FIELDS) {
    if (taken.has(f.key)) continue;
    for (let i = 0; i < norms.length; i += 1) {
      const headerKey = String(i);
      if (result[headerKey]) continue;
      const norm = norms[i] || '';
      if (f.aliases.includes(norm)) {
        result[headerKey] = f.key;
        taken.add(f.key);
        break;
      }
    }
  }

  // PASS 2 — token-match for still-unassigned headers. Tokens are
  // alphanumeric runs split on '_'. A header matches a field if at
  // least one token equals an alias verbatim. Pick the field whose
  // matching alias is longest (most specific).
  for (let i = 0; i < norms.length; i += 1) {
    const headerKey = String(i);
    if (result[headerKey]) continue;
    const tokens = (norms[i] || '').split('_').filter(Boolean);
    if (!tokens.length) {
      result[headerKey] = '__skip__';
      continue;
    }
    let bestField: string | null = null;
    let bestAliasLen = 0;
    for (const f of MENU_FIELDS) {
      if (taken.has(f.key)) continue;
      let bestForField = 0;
      for (const a of f.aliases) {
        if (tokens.includes(a) && a.length > bestForField) bestForField = a.length;
      }
      if (bestForField > bestAliasLen) {
        bestAliasLen = bestForField;
        bestField = f.key;
      }
    }
    if (bestField) {
      result[headerKey] = bestField;
      taken.add(bestField);
    } else {
      result[headerKey] = '__skip__';
    }
  }

  return result;
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
      // Single pass over the whole header array — autoMatchAll
      // dedupes target fields across columns so we never silently map
      // two headers (e.g. 'name' AND 'product_name') onto the same
      // field.
      const m: Mapping = autoMatchAll(data.headers);
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

  // Strict-mode: every upload goes through the single-branch endpoint
  // with the real branchId picked from the dropdown. The multi-branch
  // routing path is gone — if a branch column exists in the file, the
  // backend treats it as a row filter, not as a routing signal.

  // Mapping validation. Two failure modes block the upload:
  //   1. A required field (Item Name, Price) isn't mapped to any
  //      column — the row insert would explode at the backend.
  //   2. The same field key is mapped to >1 column (auto-detect
  //      conflict OR a user override that left the duplicate behind).
  // We only validate when there's an active file (raw != null);
  // otherwise the empty-state Upload button shouldn't read "fix the
  // mapping" because there's no mapping yet.
  const mappingError: string | null = (() => {
    if (!raw) return null;
    const fieldCounts: Record<string, number> = {};
    for (const v of Object.values(mapping)) {
      if (!v || v === '__skip__') continue;
      fieldCounts[v] = (fieldCounts[v] || 0) + 1;
    }
    const dup = Object.entries(fieldCounts).find(([, n]) => n > 1);
    if (dup) {
      const [dupKey] = dup;
      const f = MENU_FIELDS.find((x) => x.key === dupKey);
      const label = f?.label || dupKey;
      return `Mapping conflict: '${label}' is auto-detected on multiple columns — please select the correct one and set the others to (skip this column).`;
    }
    const required = MENU_FIELDS.filter((x) => x.required);
    const missing = required.filter((x) => !fieldCounts[x.key]);
    if (missing.length) {
      const labels = missing.map((m) => `'${m.label}'`).join(', ');
      return `Missing required mapping: ${labels}. Pick a column for each required field.`;
    }
    return null;
  })();
  const canUpload = parsed.length > 0 && Boolean(selectedBranchId) && !selectedBranchId.startsWith('__') && !mappingError;

  const handleUpload = async () => {
    if (!parsed.length) {
      showToast('No rows to upload', 'error');
      return;
    }
    if (!selectedBranchId || selectedBranchId.startsWith('__')) {
      showToast('Select a target branch', 'error');
      return;
    }
    setUploading(true);
    setResult(null);
    try {
      // Single-branch route only — strict-mode upload always pins items
      // to the dropdown selection. The backend's /branches/:id/menu/csv
      // endpoint owns deduping, variant detection, and catalog sync.
      const r = (await uploadMenuCsv(selectedBranchId, parsed)) as UploadResult;
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
      <div className="flex gap-[0.35rem] mb-[0.9rem]">
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
          <div className="ch justify-between">
            <h3>📋 Menu import — CSV / XLSX</h3>
            <button type="button" className="btn-g btn-sm" onClick={downloadSample}>⬇ Sample CSV</button>
          </div>
          <div className="cb">
            <p className="text-[0.84rem] text-dim mb-[0.6rem] leading-normal">
              Drop a file or pick one to map columns and preview rows. Include a <strong>branch</strong>
              column to split rows across branches — otherwise items are added to the branch you
              pick below.
            </p>

            {parsed.length > 0 && (
              <div className="mb-[0.6rem]">
                <div className="flex gap-[0.4rem] items-center">
                  <label className="text-[0.82rem] text-dim">Target branch:</label>
                  <select
                    value={selectedBranchId}
                    onChange={(e) => setSelectedBranchId(e.target.value)}
                    className="py-[0.4rem] px-[0.6rem] rounded-[7px] border border-rim text-[0.85rem]"
                  >
                    <option value="">Select…</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className="text-[0.74rem] text-dim mt-[0.3rem]">
                  Required — pick the target branch where these items should be imported. If your file has a branch column, only matching rows will be imported.
                </div>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFile}
              className="mb-[0.7rem]"
            />

            {raw && (
              <>
                <p className="text-[0.82rem] text-dim mb-2">
                  <strong>{fileName}</strong> · {raw.rows.length} rows
                  {multiBranch && ' · 🏪 Branch column detected — only rows matching the selected branch below will be imported'}
                </p>

                <h4 className="text-[0.84rem] my-2">🗂️ Map columns</h4>
                {mappingError && (
                  <div
                    className="py-2 px-[0.7rem] mb-2 bg-[rgba(220,38,38,0.08)] border border-[rgba(220,38,38,0.4)] text-[#dc2626] rounded-md text-[0.8rem]"
                    role="alert"
                  >
                    ⚠️ {mappingError}
                  </div>
                )}
                <div className="grid grid-cols-[1fr_auto_1fr] gap-[0.4rem] mb-[0.7rem]">
                  {raw.headers.map((h, i) => (
                    <div key={i} className="contents">
                      <div className="text-[0.8rem] py-[0.35rem] px-2 bg-ink2 rounded-md">{h || '(empty)'}</div>
                      <div className="self-center text-dim">→</div>
                      <select
                        value={mapping[i] || '__skip__'}
                        onChange={(e) => updateMapping(i, e.target.value)}
                        className="py-[0.35rem] px-2 rounded-md border border-rim text-[0.82rem]"
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

                <h4 className="text-[0.84rem] mt-[0.6rem] mb-[0.3rem]">Preview (first 8 rows)</h4>
                <div className="overflow-x-auto mb-[0.7rem]">
                  <table className="w-full border-collapse text-[0.8rem]">
                    <thead>
                      <tr>
                        <th className="text-left p-[0.3rem] text-dim">#</th>
                        {multiBranch && <th className="text-left p-[0.3rem] text-dim">🏪</th>}
                        <th className="text-left p-[0.3rem] text-dim">Name</th>
                        <th className="text-left p-[0.3rem] text-dim">Category</th>
                        <th className="text-left p-[0.3rem] text-dim">Price</th>
                        <th className="text-left p-[0.3rem] text-dim">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.slice(0, 8).map((r, i) => (
                        <tr key={i}>
                          <td className="text-dim py-1 px-[0.3rem]">{i + 1}</td>
                          {multiBranch && <td className="text-wa py-1 px-[0.3rem]">{r.branch || r.outlet || r.location || '—'}</td>}
                          <td className="py-1 px-[0.3rem]">{r.name || <span className="text-[#dc2626]">missing</span>}</td>
                          <td className="py-1 px-[0.3rem]">{r.category || '—'}</td>
                          <td className="py-1 px-[0.3rem]">{r.price ? `₹${r.price}` : <span className="text-[#dc2626]">missing</span>}</td>
                          <td className="py-1 px-[0.3rem]">{r.food_type || 'veg'}</td>
                        </tr>
                      ))}
                      {parsed.length > 8 && (
                        <tr><td colSpan={multiBranch ? 6 : 5} className="text-center text-dim p-[0.3rem]">+ {parsed.length - 8} more rows…</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="flex gap-2">
                  <button type="button" className="btn-p" onClick={handleUpload} disabled={uploading || !canUpload}>
                    {uploading ? 'Uploading…' : '⬆ Upload & Sync'}
                  </button>
                  <button type="button" className="btn-g" onClick={resetInline} disabled={uploading}>Reset</button>
                </div>
              </>
            )}

            {result && (
              <div className="mt-[0.8rem] p-[0.7rem] bg-[#ecfccb] border border-[#bef264] rounded-lg text-[0.82rem]">
                ✅ <strong>{result.added || 0}</strong> items added/updated
                {result.skipped ? <> · ⚠️ <strong>{result.skipped}</strong> skipped</> : null}
                {result.errors?.length ? (
                  <div className="mt-2 text-[#991b1b] text-[0.76rem]">
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
            <p className="text-[0.84rem] text-dim mb-[0.7rem]">
              Uploads your .xlsx to the server, which auto-maps columns. Good for bigger files.
              New products land in <strong>Unassigned</strong> — assign them to a branch in the
              Menu Editor after import.
            </p>
            <div className="flex gap-[0.35rem] mb-[0.7rem]">
              {(['upload', 'map', 'done'] as const).map((step, i) => (
                <span
                  key={step}
                  className={`py-1 px-[0.6rem] rounded-full text-[0.72rem] font-semibold ${
                    wStep === step ? 'bg-[#4f46e5] text-white' : 'bg-ink2 text-dim'
                  }`}
                >
                  {i + 1}. {step}
                </span>
              ))}
            </div>

            {wStep === 'upload' && (
              <div>
                <input type="file" accept=".xlsx" onChange={handleWFile} />
                <div className="mt-[0.7rem] flex gap-2">
                  <button type="button" className="btn-p" onClick={doWUpload} disabled={wUploading || !wFile}>
                    {wUploading ? 'Uploading…' : 'Upload & preview'}
                  </button>
                </div>
              </div>
            )}

            {wStep === 'map' && (
              <div>
                <h4 className="text-[0.84rem] mt-[0.3rem] mb-2">Review mapping</h4>
                <div className="grid grid-cols-[140px_1fr] gap-y-[0.4rem] gap-x-[0.6rem] mb-[0.7rem]">
                  {wTargetFields.map((f) => (
                    <div key={f} className="contents">
                      <label className="font-semibold text-[0.82rem] self-center capitalize">
                        {f.replace('_', ' ')}
                      </label>
                      <select
                        value={wOverrides[f] || ''}
                        onChange={(e) => setWOverrides((o) => ({ ...o, [f]: e.target.value }))}
                        className="py-[0.35rem] px-2 rounded-md border border-rim text-[0.82rem]"
                      >
                        <option value="">— none —</option>
                        {wHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>

                {wSample.length > 0 && (
                  <>
                    <h4 className="text-[0.84rem] mt-2 mb-[0.3rem]">Sample rows</h4>
                    <div className="overflow-x-auto mb-[0.7rem] border border-rim rounded-md">
                      <table className="w-full border-collapse text-[0.78rem]">
                        <thead>
                          <tr className="bg-[#f3f4f6]">
                            {wHeaders.map((h) => <th key={h} className="text-left py-[0.3rem] px-2">{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {wSample.slice(0, 8).map((r, i) => (
                            <tr key={i}>
                              {wHeaders.map((h) => (
                                <td key={h} className="py-1 px-2 border-t border-[#f1f5f9]">
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

                <div className="flex gap-2">
                  <button type="button" className="btn-p" onClick={doWImport} disabled={wImporting}>
                    {wImporting ? 'Importing…' : 'Import products'}
                  </button>
                  <button type="button" className="btn-g" onClick={resetWizard} disabled={wImporting}>Start over</button>
                </div>
              </div>
            )}

            {wStep === 'done' && wResult && (
              <div>
                <div className="text-base font-semibold mb-[0.4rem]">✅ Import complete</div>
                <div>Total rows: <strong>{wResult.total}</strong></div>
                <div>Inserted: <strong className="text-[#059669]">{wResult.inserted}</strong></div>
                <div>Skipped: <strong className="text-[#b45309]">{wResult.skipped}</strong></div>
                <div className="text-[0.82rem] text-dim mt-[0.4rem]">
                  Ready: {wResult.ready} · Incomplete (Meta): {wResult.incomplete}
                </div>
                <div className="text-[0.78rem] text-dim mt-2">
                  New products start as <strong>Unassigned</strong>. Assign them to a branch to
                  make them visible.
                </div>
                <button type="button" className="btn-g btn-sm mt-[0.6rem]" onClick={resetWizard}>
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
