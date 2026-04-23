import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import Toggle from '../../../components/Toggle.jsx';
import BranchFormModal from './BranchFormModal.jsx';
import BranchHoursEditor from './BranchHoursEditor.jsx';
import BranchMenuSection from './BranchMenuSection.jsx';
import {
  getBranches,
  updateBranch,
  importBranchesCsv,
} from '../../../api/restaurant.js';

// Mirrors renderBranchCard + loadBranches + doToggle + doUploadOutletCsv
// (menu.js:253-493 + 126-250). Legacy used imperative DOM; we keep the same
// class names (bcard/bcard-hd/bcard-name/bcard-badges/bcard-body/tsl/ipair)
// so CSS continues to apply.
//
// Inline edits replace the legacy `onchange="doToggle(…)"` callbacks with
// React state; each field PATCHes the branch then optimistically updates the
// row. No window.confirm anywhere — the legacy UI had none for branches.
const GEOCODE_DELAY_MS = 1100; // Nominatim: 1 req/sec

function formatHoursSummary(b) {
  const oh = b.operating_hours;
  if (!oh) return `${(b.opening_time || '10:00').slice(0, 5)} – ${(b.closing_time || '22:00').slice(0, 5)}`;
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const openDays = days.filter((d) => !oh[d]?.is_closed);
  if (!openDays.length) return 'Closed all days';
  const first = oh[openDays[0]];
  const allSame = openDays.every((d) => oh[d].open === first.open && oh[d].close === first.close);
  const t = `${first.open} – ${first.close}`;
  if (openDays.length === 7 && allSame) return t;
  if (allSame) {
    const closed = 7 - openDays.length;
    return `${t} (${closed} day${closed > 1 ? 's' : ''} closed)`;
  }
  return 'Custom schedule';
}

// Nominatim geocode for branches missing lat/lng during CSV import.
// Matches menu.js:171-179 — India only, English, rate-limited by the caller.
async function geocodeAddress(address) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&countrycodes=in&limit=1`,
    { headers: { 'Accept-Language': 'en' } },
  );
  const data = await res.json();
  if (!data.length) throw new Error(`Address not found: "${address}"`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

function simpleCsvParse(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line) => {
    const out = []; let cur = ''; let inQ = false;
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
  const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const rows = lines.slice(1).map((l) => {
    const vals = split(l);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
  return { headers, rows };
}

export default function BranchesSection() {
  const { showToast } = useToast();
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState(null); // null = create mode; row = edit mode
  const [expandedId, setExpandedId] = useState(null);
  const [expandedPane, setExpandedPane] = useState('hours'); // 'hours' | 'menu'
  const [savingField, setSavingField] = useState(null); // `${id}:${field}` while PATCH in-flight

  const openCreate = () => { setEditingBranch(null); setModalOpen(true); };
  const openEdit = (b) => { setEditingBranch(b); setModalOpen(true); };
  const closeModal = () => { setModalOpen(false); setEditingBranch(null); };

  // CSV state
  const [csvRows, setCsvRows] = useState([]);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvProgress, setCsvProgress] = useState('');
  const [csvResult, setCsvResult] = useState(null);
  const [csvShow, setCsvShow] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const list = await getBranches();
      setBranches(Array.isArray(list) ? list : []);
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to load branches', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const patchField = async (id, field, value) => {
    setSavingField(`${id}:${field}`);
    setBranches((list) => list.map((b) => b.id === id ? { ...b, [toSnake(field)]: value } : b));
    try {
      await updateBranch(id, { [field]: value });
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Save failed', 'error');
      load();
    } finally {
      setSavingField(null);
    }
  };

  const handleCsvFile = async (file) => {
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
    } catch (err) {
      showToast('Could not parse CSV: ' + err.message, 'error');
    }
  };

  const handleCsvUpload = async () => {
    if (!csvRows.length) return;
    setCsvBusy(true);
    setCsvResult(null);

    // Geocode rows missing lat/lng. Nominatim rate-limited to 1 req/sec.
    const toGeocode = csvRows.filter((r) => !r.latitude || !r.longitude);
    const geocodeFailed = [];
    const rowsCopy = csvRows.map((r) => ({ ...r }));

    for (let i = 0; i < toGeocode.length; i++) {
      setCsvProgress(`Geocoding ${i + 1}/${toGeocode.length}…`);
      try {
        if (i > 0) await new Promise((res) => setTimeout(res, GEOCODE_DELAY_MS));
        const { lat, lng } = await geocodeAddress(toGeocode[i].address);
        // Find matching row in rowsCopy and update
        const idx = rowsCopy.findIndex((r) => r === toGeocode[i] || (r.branch_name === toGeocode[i].branch_name && r.address === toGeocode[i].address));
        if (idx >= 0) {
          rowsCopy[idx].latitude = String(lat);
          rowsCopy[idx].longitude = String(lng);
        }
      } catch (e) {
        geocodeFailed.push({ name: toGeocode[i].branch_name, reason: e.message });
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
      const r = await importBranchesCsv(readyRows);
      setCsvResult({ created: r.created || 0, errors: r.errors, details: r.details, geocodeFailed });
      if (r.created) {
        showToast(`✅ ${r.created} branch${r.created !== 1 ? 'es' : ''} created!`, 'success');
        setCsvRows([]);
        load();
        setTimeout(load, 5000);
      }
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'CSV upload failed', 'error');
    } finally {
      setCsvBusy(false);
      setCsvProgress('');
    }
  };

  const downloadSample = () => {
    const sample = [
      'branch_name,address,city,latitude,longitude,delivery_radius_km,opening_time,closing_time,manager_phone',
      'Koramangala Outlet,"Shop 5, Forum Mall, Koramangala, Bangalore 560095",Bangalore,12.934533,77.612487,5,10:00,22:00,+919876543210',
      'Indiranagar Branch,"100 Feet Road, Indiranagar, Bangalore 560038",Bangalore,,,5,11:00,23:00,+919876543211',
      'HSR Layout,"Sector 2, HSR Layout, Bangalore 560102",Bangalore,,,4,10:00,22:00,',
    ].join('\n');
    const blob = new Blob([sample], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gullybite_outlets_sample.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const expanded = useMemo(
    () => (expandedId ? branches.find((b) => b.id === expandedId) : null),
    [expandedId, branches],
  );

  return (
    <div>
      {/* Header */}
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
                <code>delivery_radius_km</code>, <code>opening_time</code>, <code>closing_time</code>,{' '}
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

      {/* Branch list */}
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
          {branches.map((b) => {
            const isExpanded = expandedId === b.id;
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
                }}
              >
                <div
                  className="bcard-hd"
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: '.7rem',
                    padding: '.75rem .95rem', cursor: 'pointer',
                    background: isExpanded ? 'var(--ink2,#f4f4f5)' : 'transparent',
                  }}
                  onClick={() => setExpandedId(isExpanded ? null : b.id)}
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
                    <span style={{ fontSize: '.85rem', color: 'var(--dim)', marginLeft: '.4rem' }}>
                      {isExpanded ? '▾' : '▸'}
                    </span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="bcard-body" style={{ padding: '.9rem' }}>
                    {/* Top action row — full editor (modal) + space for future Phase-3 Delete */}
                    <div
                      className="bcard-actions"
                      style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '.7rem' }}
                    >
                      <button
                        type="button"
                        className="btn-g btn-sm"
                        onClick={(e) => { e.stopPropagation(); openEdit(b); }}
                        title="Edit all branch details (name, address, hours, FSSAI…)"
                      >
                        ✏️ Edit Branch
                      </button>
                    </div>

                    {/* Quick-info pairs */}
                    <div
                      className="ipair-row"
                      style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '.7rem', fontSize: '.78rem' }}
                    >
                      <div className="ipair">
                        <label style={{ color: 'var(--dim)', marginRight: '.3rem' }}>Radius</label>
                        <code>{b.delivery_radius_km} km</code>
                      </div>
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

                    {/* Toggles */}
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

                    {/* Sub-section nav inside expand panel */}
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

      <BranchFormModal
        open={modalOpen}
        mode={editingBranch ? 'edit' : 'create'}
        existingBranch={editingBranch}
        onClose={closeModal}
        onSaved={() => {
          load();
          // Create flow runs background catalog provisioning, so a couple
          // of delayed reloads catch the catalog_id once it's saved.
          if (!editingBranch) {
            setTimeout(load, 3500);
            setTimeout(load, 7000);
          }
        }}
      />
    </div>
  );
}

// camelCase ➜ snake_case for optimistic field updates against the API's
// snake_case response shape.
function toSnake(camel) {
  return camel.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
}
