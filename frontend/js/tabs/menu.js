// frontend/js/tabs/menu.js
// Dashboard tab: Menu (Branches, Catalog, Categories, Variants, Product Sets, Collections, CSV, Images)

(function() {

// ─── Catalog info bar for Menu page ──────────────────────
function renderCatalogBar() {
  var bar = document.getElementById('menu-catalog-bar');
  if (!bar || typeof rest === 'undefined' || !rest) return;
  var catId = rest.meta_catalog_id;
  var wa = (rest.waba_accounts || [])[0];
  var phone = wa?.phone || rest.wa_phone_number || null;
  var wabaId = wa?.waba_id || rest.meta_waba_id || null;

  if (catId) {
    bar.style.display = 'flex';
    bar.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0"></span>'
      + '<span style="color:var(--wa);font-weight:600">Catalog Connected</span>'
      + '<span style="color:var(--rim)">|</span>'
      + '<span style="color:var(--dim)">Catalog: <span style="font-family:monospace">' + catId + '</span>'
      + ' <button onclick="navigator.clipboard.writeText(\'' + catId + '\');toast(\'Copied!\',\'ok\')" style="background:none;border:none;cursor:pointer;font-size:.65rem;color:var(--acc);padding:0">\uD83D\uDCCB</button></span>'
      + (wabaId ? '<span style="color:var(--rim)">|</span><span style="color:var(--dim)">WABA: <span style="font-family:monospace">' + wabaId + '</span></span>' : '')
      + (phone ? '<span style="color:var(--rim)">|</span><span style="color:var(--dim)">' + phone + '</span>' : '');
  } else {
    bar.style.display = 'flex';
    bar.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#dc2626;flex-shrink:0"></span>'
      + '<span style="color:var(--red);font-weight:600">No Catalog Connected</span>'
      + '<span style="color:var(--rim)">|</span>'
      + '<button onclick="goTab(\'settings\',null)" style="background:none;border:none;color:var(--acc);font-size:.78rem;cursor:pointer;padding:0">Connect in Settings \u2192</button>';
    // Disable sync buttons
    var syncTo = document.getElementById('sync-to-btn');
    var syncFrom = document.getElementById('sync-from-btn');
    if (syncTo) { syncTo.disabled = true; syncTo.title = 'Connect a catalog in Settings first'; }
    if (syncFrom) { syncFrom.disabled = true; syncFrom.title = 'Connect a catalog in Settings first'; }
  }
}

let _addrTimer = null, _addrHighlight = -1, _addrSuggestions = [];

function addrSearch(q) {
  clearTimeout(_addrTimer);
  const box = document.getElementById('addr-suggestions');
  const input = document.getElementById('b-addr-search');
  _addrHighlight = -1;
  if (!q || q.length < 2) { box.style.display = 'none'; _addrSuggestions = []; _setAddrIcon('search'); return; }
  _setAddrIcon('loading');
  _addrTimer = setTimeout(async () => {
    try {
      const res = await api(`/api/restaurant/places/autocomplete?input=${encodeURIComponent(q)}`);
      _addrSuggestions = res.suggestions || [];
      if (!_addrSuggestions.length) { box.style.display = 'none'; _setAddrIcon('search'); return; }
      box.innerHTML = _addrSuggestions.map((s, i) =>
        `<div class="addr-item" data-i="${i}"
          style="padding:.65rem .9rem;cursor:pointer;font-size:.83rem;border-bottom:1px solid var(--bdr);line-height:1.4"
          onmouseover="_addrHover(${i})" onclick="addrPick(${i})"
        ><div style="font-weight:600;color:var(--txt)">${_esc(s.mainText)}</div>
         <div style="font-size:.77rem;color:var(--dim);margin-top:.15rem">${_esc(s.secondaryText)}</div></div>`
      ).join('');
      box.style.display = 'block';
      _setAddrIcon('search');
    } catch { box.style.display = 'none'; _setAddrIcon('search'); }
  }, 300);
}

function _addrHover(i) {
  _addrHighlight = i;
  _addrHighlightUpdate();
}

function _addrHighlightUpdate() {
  const items = document.querySelectorAll('#addr-suggestions .addr-item');
  items.forEach((el, i) => el.style.background = i === _addrHighlight ? 'var(--ink3)' : '');
}

function _addrKeydown(e) {
  const box = document.getElementById('addr-suggestions');
  if (box.style.display === 'none' || !_addrSuggestions.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); _addrHighlight = Math.min(_addrHighlight + 1, _addrSuggestions.length - 1); _addrHighlightUpdate(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); _addrHighlight = Math.max(_addrHighlight - 1, 0); _addrHighlightUpdate(); }
  else if (e.key === 'Enter' && _addrHighlight >= 0) { e.preventDefault(); addrPick(_addrHighlight); }
  else if (e.key === 'Escape') { box.style.display = 'none'; }
}

async function addrPick(i) {
  const box = document.getElementById('addr-suggestions');
  const s = _addrSuggestions[i];
  if (!s) return;
  box.style.display = 'none';
  _setAddrIcon('loading');
  document.getElementById('b-addr-search').value = s.fullText;
  try {
    const details = await api(`/api/restaurant/places/details?placeId=${encodeURIComponent(s.place_id)}`);
    document.getElementById('b-addr-search').value = details.full_address;
    document.getElementById('b-addr').value   = details.full_address;
    document.getElementById('b-city').value   = details.city || '';
    document.getElementById('b-lat').value    = details.lat;
    document.getElementById('b-lng').value    = details.lng;
    // Store extra fields for saving
    document.getElementById('b-addr-search')._placeData = details;
    // Show confirmation line
    const conf = document.getElementById('addr-confirm');
    const parts = [details.area, details.city, details.pincode].filter(Boolean);
    if (parts.length) { conf.textContent = parts.join(', '); conf.style.display = 'block'; }
    else { conf.style.display = 'none'; }
  } catch (e) {
    toast('Could not fetch address details: ' + e.message, 'err');
  }
  _setAddrIcon('search');
}

function _setAddrIcon(type) {
  const ico = document.getElementById('addr-search-icon');
  if (!ico) return;
  if (type === 'loading') ico.innerHTML = '<div class="spin" style="width:14px;height:14px;border-width:2px"></div>';
  else ico.innerHTML = '🔍';
}

// _esc() is in shared.js

document.addEventListener('click', e => {
  if (!e.target.closest('#addr-suggestions') && e.target.id !== 'b-addr-search')
    document.getElementById('addr-suggestions').style.display = 'none';
});


let outletCsvParsed = [], _outletCsvRaw = null;

function handleOutletCsvFile(input) {
  const file = input.files[0]; if (!file) return;
  processOutletFile(file);
}
function handleOutletCsvDrop(e) {
  const file = e.dataTransfer.files[0]; if (!file) return;
  processOutletFile(file);
}
async function processOutletFile(file) {
  try {
    _outletCsvRaw = await parseFile(file);
    document.getElementById('outlet-csv-preview').style.display = 'none';
    document.getElementById('outlet-csv-result').style.display  = 'none';
    renderMapper('csv-mapper-outlet', _outletCsvRaw.headers, OUTLET_FIELDS, mapping => {
      const mapped = applyMapping(_outletCsvRaw.rows, mapping);
      outletCsvParsed = mapped.filter(r => (r.branch_name||'').trim() && (r.address||'').trim());
      if (!outletCsvParsed.length) return toast('No rows with both Branch Name and Address after mapping', 'err');
      const tbody = document.getElementById('outlet-csv-preview-body');
      tbody.innerHTML = outletCsvParsed.map((r, i) => {
        const hasCoords = r.latitude && r.longitude;
        return `<tr>
          <td>${i+1}</td><td><strong>${r.branch_name}</strong></td><td>${r.city||'—'}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.address}">${r.address}</td>
          <td>${r.delivery_radius_km||'5'}</td>
          <td>${hasCoords
            ? '<span style="color:var(--wa);font-size:.75rem">✅ coords set</span>'
            : '<span style="color:var(--dim);font-size:.75rem">📍 will geocode</span>'}</td>
        </tr>`;
      }).join('');
      document.getElementById('outlet-csv-count').textContent = `${outletCsvParsed.length} outlet${outletCsvParsed.length>1?'s':''} ready`;
      document.getElementById('outlet-csv-preview').style.display = 'block';
    });
  } catch (e) { toast('Could not parse CSV: ' + e.message, 'err'); }
}
function resetOutletCsv() {
  outletCsvParsed = []; _outletCsvRaw = null;
  document.getElementById('outlet-csv-file').value = '';
  document.getElementById('csv-mapper-outlet').style.display  = 'none';
  document.getElementById('outlet-csv-preview').style.display = 'none';
  document.getElementById('outlet-csv-result').style.display  = 'none';
}

// Geocode a single address via Nominatim (frontend, no API key needed)
async function geocodeAddress(address) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&countrycodes=in&limit=1`,
    { headers: { 'Accept-Language': 'en' } }
  );
  const data = await res.json();
  if (!data.length) throw new Error(`Address not found: "${address}"`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

async function doUploadOutletCsv() {
  if (!outletCsvParsed.length) return toast('No CSV data to upload', 'err');
  const btn = document.getElementById('outlet-csv-btn');
  const el  = document.getElementById('outlet-csv-result');
  btn.disabled = true;

  // Step 1 — geocode any rows missing lat/lng (frontend, 1 req/sec Nominatim limit)
  const toGeocode = outletCsvParsed.filter(r => !r.latitude || !r.longitude);
  const geocodeFailed = [];
  if (toGeocode.length) {
    btn.innerHTML = `<div class="spin"></div> Geocoding 0/${toGeocode.length}…`;
    for (let i = 0; i < toGeocode.length; i++) {
      btn.innerHTML = `<div class="spin"></div> Geocoding ${i+1}/${toGeocode.length}…`;
      try {
        if (i > 0) await new Promise(r => setTimeout(r, 1100)); // Nominatim: 1 req/sec
        const { lat, lng } = await geocodeAddress(toGeocode[i].address);
        toGeocode[i].latitude  = String(lat);
        toGeocode[i].longitude = String(lng);
      } catch (ge) {
        geocodeFailed.push({ name: toGeocode[i].branch_name, reason: ge.message });
      }
    }
  }

  // Step 2 — send all successfully geocoded rows to backend
  const readyRows = outletCsvParsed.filter(r => r.latitude && r.longitude);
  if (!readyRows.length) {
    el.style.display = 'block';
    el.innerHTML = `<div style="color:var(--red);font-size:.83rem">❌ Could not geocode any addresses. Try adding latitude/longitude columns manually.<br>
      ${geocodeFailed.map(f=>`<strong>${f.name}</strong>: ${f.reason}`).join('<br>')}</div>`;
    btn.disabled = false; btn.innerHTML = '📍 Create Branches';
    return;
  }

  btn.innerHTML = `<div class="spin"></div> Creating ${readyRows.length} branch${readyRows.length>1?'es':''}…`;
  try {
    const r = await api('/api/restaurant/branches/csv', { method: 'POST', body: { branches: readyRows } });
    el.style.display = 'block';
    const failedGeoHtml = geocodeFailed.length
      ? `<div style="margin-top:.45rem;font-size:.75rem;color:var(--red)">📍 Geocoding failed (add coordinates manually):<br>${geocodeFailed.map(f=>`<strong>${f.name}</strong>: ${f.reason}`).join('<br>')}</div>` : '';
    const errHtml = r.details?.errors?.length
      ? `<div style="margin-top:.45rem;font-size:.75rem;color:var(--red)">${r.details.errors.slice(0,5).map(e=>`<strong>${e.row?.branch_name||'Row'}</strong>: ${e.reason}`).join('<br>')}</div>` : '';
    el.innerHTML =
      `<div style="display:flex;gap:.6rem;flex-wrap:wrap">
        <span class="csv-result-ok">✅ <strong>${r.created}</strong> branch${r.created!==1?'es':''} created</span>
        ${geocodeFailed.length ? `<span class="csv-result-warn">⚠️ <strong>${geocodeFailed.length}</strong> geocoding failed</span>` : ''}
        ${r.errors ? `<span style="background:rgba(220,38,38,.12);color:#dc2626;padding:.2rem .55rem;border-radius:6px;font-size:.8rem">❌ <strong>${r.errors}</strong> failed</span>` : ''}
        ${r.created ? `<span style="font-size:.8rem;color:var(--dim)">WhatsApp catalogs creating in background…</span>` : ''}
      </div>${failedGeoHtml}${errHtml}`;
    if (r.created) {
      toast(`✅ ${r.created} branch${r.created!==1?'es':''} created!`, 'ok');
      resetOutletCsv();
      loadBranches();
      setTimeout(loadBranches, 5000);
    }
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '📍 Create Branches'; }
}
function doDownloadOutletSample() {
  const sample = [
    'branch_name,address,city,latitude,longitude,delivery_radius_km,opening_time,closing_time,manager_phone',
    'Koramangala Outlet,"Shop 5, Forum Mall, Koramangala, Bangalore 560095",Bangalore,12.934533,77.612487,5,10:00,22:00,+919876543210',
    'Indiranagar Branch,"100 Feet Road, Indiranagar, Bangalore 560038",Bangalore,,,5,11:00,23:00,+919876543211',
    'HSR Layout,"Sector 2, HSR Layout, Bangalore 560102",Bangalore,,,4,10:00,22:00,',
  ].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(sample);
  a.download = 'gullybite_outlets_sample.csv';
  a.click();
}


async function doAddBranch() {
  const btn  = document.getElementById('add-b-btn');
  const name = document.getElementById('b-name').value.trim();
  const lat  = parseFloat(document.getElementById('b-lat').value);
  const lng  = parseFloat(document.getElementById('b-lng').value);
  if (!name || isNaN(lat) || isNaN(lng)) return toast('Branch name and address selection are required', 'err');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Creating...';
  try {
    const placeData = document.getElementById('b-addr-search')._placeData || {};
    await api('/api/restaurant/branches', { method: 'POST', body: {
      name, city: document.getElementById('b-city').value || placeData.city || '',
      address: document.getElementById('b-addr').value,
      latitude: lat, longitude: lng,
      pincode: placeData.pincode || '',
      area: placeData.area || '',
      state: placeData.state || '',
      place_id: placeData.place_id || '',
      deliveryRadiusKm: parseFloat(document.getElementById('b-rad').value) || 5,
      openingTime: document.getElementById('b-open').value,
      closingTime: document.getElementById('b-close').value,
      managerPhone: document.getElementById('b-mgr').value,
    }});
    ['b-name', 'b-city', 'b-addr', 'b-addr-search', 'b-lat', 'b-lng', 'b-mgr'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('b-addr-search')._placeData = null;
    document.getElementById('addr-confirm').style.display = 'none';
    toast(`✅ "${name}" added! Creating WhatsApp catalog...`, 'ok');
    loadBranches();
    setTimeout(loadBranches, 3500);
    setTimeout(loadBranches, 7000);
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '+ Add Branch'; }
}

async function loadBranches() {
  const list = document.getElementById('branch-list');
  try {
    const data = await api('/api/restaurant/branches');
    branches = data || [];
    if (!branches.length) {
      list.innerHTML = `<div class="empty"><div class="ei">📍</div><h3>No branches yet</h3><p>Add your first branch above</p></div>`;
      return;
    }
    list.innerHTML = branches.map(b => renderBranchCard(b)).join('');
  } catch (e) { toast('Failed to load branches: ' + e.message, 'err'); }
}

function _formatHoursSummary(b) {
  if (!b.operating_hours) return `${(b.opening_time||'10:00').slice(0,5)} \u2013 ${(b.closing_time||'22:00').slice(0,5)}`;
  const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const openDays = days.filter(d => !b.operating_hours[d]?.is_closed);
  if (!openDays.length) return 'Closed all days';
  const first = b.operating_hours[openDays[0]];
  const allSame = openDays.every(d => b.operating_hours[d].open === first.open && b.operating_hours[d].close === first.close);
  const timeStr = `${first.open} \u2013 ${first.close}`;
  if (openDays.length === 7 && allSame) return timeStr;
  if (allSame) {
    const closedCount = 7 - openDays.length;
    return `${timeStr} (${closedCount}d closed)`;
  }
  return `${(b.opening_time||'10:00').slice(0,5)} \u2013 ${(b.closing_time||'22:00').slice(0,5)} (varies)`;
}
function renderBranchCard(b) {
  let catHtml = '';
  if (!b.catalog_id) {
    catHtml = `
      <div class="cat-strip">
        <div class="cat-inner">
          <div class="cat-ico">⏳</div>
          <div class="cat-inf">
            <h4 style="color:var(--gold2)">Catalog not created yet</h4>
            <p>Catalog is created automatically when you add menu items. Or click ⚡ to create now.</p>
          </div>
          <div class="cat-acts">
            <button class="btn-p btn-sm" onclick="doCreateCatalog('${b.id}','${b.name.replace(/'/g, "\\'")}',this)">⚡ Create Catalog</button>
            <button class="btn-g btn-sm" onclick="loadBranches()">🔄 Refresh</button>
          </div>
        </div>
      </div>`;
  } else if (!b.catalog_synced_at) {
    catHtml = `
      <div class="cat-strip">
        <div class="cat-inner">
          <div class="cat-ico">✅</div>
          <div class="cat-inf">
            <h4 style="color:var(--wa)">Catalog Created — Needs First Sync</h4>
            <p>Your WhatsApp catalog exists. Add menu items then click <strong>Sync Menu</strong> to push them to WhatsApp customers.</p>
            <div class="cat-id">${b.catalog_id}</div>
          </div>
          <div class="cat-acts">
            <button class="btn-p btn-sm" id="sbtn-${b.id}" onclick="doSync('${b.id}','${b.name.replace(/'/g, "\\'")}')">🔄 Sync Menu</button>
            <button class="btn-g btn-sm" onclick="goTab('menu',null);doSelectBranch('${b.id}')">🍽️ Add Items</button>
          </div>
        </div>
        <div class="sp-strip" id="sp-${b.id}">
          <div class="sp-row"><span id="sp-lbl-${b.id}">Syncing to WhatsApp...</span><span id="sp-pct-${b.id}">0%</span></div>
          <div class="prog-wrap"><div class="prog-bar" id="sp-bar-${b.id}" style="width:0%"></div></div>
        </div>
      </div>`;
  } else {
    const when = new Date(b.catalog_synced_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    catHtml = `
      <div class="cat-strip">
        <div class="cat-inner">
          <div class="cat-ico">🟢</div>
          <div class="cat-inf">
            <h4 style="color:var(--wa)">Live on WhatsApp ✓</h4>
            <p>Customers near this branch see this catalog. Last synced <strong>${when}</strong>.</p>
            <div class="cat-id">${b.catalog_id}</div>
          </div>
          <div class="cat-acts">
            <button class="btn-p btn-sm" id="sbtn-${b.id}" onclick="doSync('${b.id}','${b.name.replace(/'/g, "\\'")}')">🔄 Sync Menu</button>
            <button class="btn-g btn-sm" onclick="goTab('menu',null);doSelectBranch('${b.id}')">🍽️ Edit Menu</button>
          </div>
        </div>
        <div class="sp-strip" id="sp-${b.id}">
          <div class="sp-row"><span id="sp-lbl-${b.id}">Syncing to WhatsApp...</span><span id="sp-pct-${b.id}">0%</span></div>
          <div class="prog-wrap"><div class="prog-bar" id="sp-bar-${b.id}" style="width:0%"></div></div>
        </div>
      </div>`;
  }

  return `<div class="bcard" id="bc-${b.id}">
    <div class="bcard-hd">
      <div style="flex:1;min-width:0">
        <div class="bcard-name">${b.name}</div>
        <div class="bcard-addr">${b.address || b.city || '—'} <a href="#" onclick="event.preventDefault();editBranchAddr('${b.id}')" style="font-size:.72rem;color:var(--wa);margin-left:.4rem;text-decoration:none">edit</a></div>
      </div>
      <div class="bcard-badges">
        <span class="badge ${b.is_open ? 'bg' : 'br'}">${b.is_open ? '🟢 Open' : '🔴 Closed'}</span>
        <span class="badge ${b.accepts_orders ? 'bg' : 'ba'}">${b.accepts_orders ? 'Taking Orders' : 'Paused'}</span>
      </div>
    </div>
    <div class="bcard-body">
      <div class="ipair-row">
        <div class="ipair"><label>Latitude</label><code>${b.latitude}</code></div>
        <div class="ipair"><label>Longitude</label><code>${b.longitude}</code></div>
        <div class="ipair"><label>Radius</label><code>${b.delivery_radius_km} km</code></div>
        <div class="ipair"><label>Hours</label><code>${_formatHoursSummary(b)}</code> <a href="#" onclick="event.preventDefault();goTab('restaurant',null)" style="font-size:.72rem;color:var(--wa);margin-left:.3rem;text-decoration:none">edit</a></div>
        <div class="ipair"><label>Base Prep</label><input type="number" value="${b.base_prep_time_min ?? 15}" min="5" max="60" style="width:50px;padding:.2rem .4rem;border:1px solid var(--rim);border-radius:4px;font-size:.78rem" onchange="doToggle('${b.id}','basePrepTimeMin',this.value)"> min</div>
        <div class="ipair"><label>Per-Item</label><input type="number" value="${b.avg_item_prep_min ?? 3}" min="0" max="15" style="width:50px;padding:.2rem .4rem;border:1px solid var(--rim);border-radius:4px;font-size:.78rem" onchange="doToggle('${b.id}','avgItemPrepMin',this.value)"> min</div>
        <div class="ipair"><label>Manager Phone</label><input type="text" value="${b.manager_phone || ''}" placeholder="919876543210" style="width:120px;padding:.2rem .4rem;border:1px solid var(--rim);border-radius:4px;font-size:.78rem" onchange="doToggle('${b.id}','managerPhone',this.value)"></div>
      </div>
      <div class="bcard-togs">
        <div class="tog">
          <label class="tsl"><input type="checkbox" ${b.accepts_orders ? 'checked' : ''} onchange="doToggle('${b.id}','acceptsOrders',this.checked)"><div class="tsl-track"></div></label>
          <span>Accepting orders</span>
        </div>
        <div class="tog">
          <label class="tsl"><input type="checkbox" ${b.is_open ? 'checked' : ''} onchange="doToggle('${b.id}','isOpen',this.checked)"><div class="tsl-track"></div></label>
          <span>Branch open</span>
        </div>
      </div>
      <!-- Delivery Info -->
      <div style="margin-top:.75rem;padding:.6rem .8rem;background:var(--ink2);border:1px solid var(--bdr);border-radius:8px;font-size:.8rem;color:var(--dim)">
        🚴 <strong>Delivery</strong> — Fee is calculated automatically by our delivery partner based on distance. Radius: <strong>${b.delivery_radius_km || '—'} km</strong>
      </div>
      <!-- Operating Hours: managed from Restaurant tab -->
    </div>
    ${catHtml}
  </div>`;
}

async function doCreateCatalog(branchId, branchName, btn) {
  const card  = document.getElementById('bc-' + branchId);
  const strip = card?.querySelector('.cat-strip');
  if (strip) {
    strip.innerHTML = `<div class="cat-making">
      <div class="mspin"></div>
      <p>Creating catalog for <strong>${branchName}</strong>… usually takes a few seconds</p>
    </div>`;
  }
  try {
    const r = await api(`/api/restaurant/branches/${branchId}/create-catalog`, { method: 'POST' });
    if (r.success || r.alreadyExists) toast(`✅ Catalog ready for ${branchName}!`, 'ok');
    else toast(r.error || 'Catalog creation failed', 'err');
    loadBranches();
  } catch (e) { toast(e.message, 'err'); loadBranches(); }
}

// Manual catalog ID input removed — catalogs are auto-fetched from Meta

async function doSync(branchId, branchName) {
  const btn = document.getElementById('sbtn-' + branchId);
  const sp  = document.getElementById('sp-' + branchId);
  const bar = document.getElementById('sp-bar-' + branchId);
  const lbl = document.getElementById('sp-lbl-' + branchId);
  const pct = document.getElementById('sp-pct-' + branchId);
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Syncing...'; }
  if (sp) sp.classList.add('on');
  animBar(bar, pct, 0, 42, 700);
  try {
    animBar(bar, pct, 42, 78, 1100);
    if (lbl) lbl.textContent = 'Pushing items to WhatsApp Catalog...';
    const r = await api(`/api/restaurant/branches/${branchId}/sync-catalog`, { method: 'POST' });
    animBar(bar, pct, 78, 100, 350);
    if (lbl) lbl.textContent = 'Done!';
    setTimeout(() => { if (sp) sp.classList.remove('on'); }, 1500);
    if (r.success) toast(`✅ ${branchName}: ${r.updated} items live, ${r.deleted} removed`, 'ok');
    else toast(r.errors?.[0] || r.message || 'Sync failed', 'err');
    loadBranches();
  } catch (e) {
    toast(e.message, 'err');
    if (sp) sp.classList.remove('on');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '🔄 Sync Menu'; }
  }
}
function animBar(bar, pct, from, to, dur) {
  if (!bar) return;
  const t0 = performance.now();
  (function s(now) {
    const p = Math.min((now - t0) / dur, 1);
    const v = from + (to - from) * p;
    bar.style.width = v + '%';
    if (pct) pct.textContent = Math.round(v) + '%';
    if (p < 1) requestAnimationFrame(s);
  })(performance.now());
}
async function doToggle(id, field, val) {
  await api(`/api/restaurant/branches/${id}`, { method: 'PATCH', body: { [field]: val } }).catch(() => {});
}


function editBranchAddr(branchId) {
  const card = document.getElementById('bc-' + branchId);
  if (!card) return;
  const addrEl = card.querySelector('.bcard-addr');
  const b = branches.find(x => x.id === branchId);
  if (!b) return;

  addrEl.innerHTML = `
    <div style="position:relative;margin-top:.35rem">
      <input id="edit-addr-${branchId}" autocomplete="off" placeholder="Search new address..."
        value="${_esc(b.address || '')}"
        style="width:100%;padding:.45rem .6rem;padding-right:2rem;font-size:.82rem;border:1px solid var(--wa);border-radius:6px;background:var(--ink2);color:var(--txt)"
        oninput="_editAddrSearch('${branchId}', this.value)"
        onkeydown="_editAddrKeydown(event, '${branchId}')">
      <span id="edit-addr-icon-${branchId}" style="position:absolute;right:.5rem;top:50%;transform:translateY(-50%);font-size:.8rem;pointer-events:none">🔍</span>
      <div id="edit-addr-dd-${branchId}" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--ink2);border:1px solid var(--bdr);border-radius:8px;z-index:999;max-height:220px;overflow-y:auto;margin-top:3px;box-shadow:0 8px 24px rgba(0,0,0,.4)"></div>
      <div id="edit-addr-conf-${branchId}" style="display:none;font-size:.75rem;color:var(--wa);margin-top:.3rem"></div>
      <div style="display:flex;gap:.4rem;margin-top:.4rem">
        <button class="btn-p btn-sm" id="edit-addr-save-${branchId}" style="display:none" onclick="saveBranchAddr('${branchId}')">Save Address</button>
        <button class="btn-g btn-sm" onclick="loadBranches()">Cancel</button>
      </div>
    </div>`;
}

let _editAddrTimers = {}, _editAddrSuggestions = {}, _editAddrHighlight = {}, _editAddrDetails = {};

function _editAddrSearch(branchId, q) {
  clearTimeout(_editAddrTimers[branchId]);
  const dd = document.getElementById(`edit-addr-dd-${branchId}`);
  _editAddrHighlight[branchId] = -1;
  if (!q || q.length < 2) { dd.style.display = 'none'; return; }
  _editAddrTimers[branchId] = setTimeout(async () => {
    try {
      const res = await api(`/api/restaurant/places/autocomplete?input=${encodeURIComponent(q)}`);
      _editAddrSuggestions[branchId] = res.suggestions || [];
      if (!_editAddrSuggestions[branchId].length) { dd.style.display = 'none'; return; }
      dd.innerHTML = _editAddrSuggestions[branchId].map((s, i) =>
        `<div class="addr-item" data-i="${i}"
          style="padding:.55rem .8rem;cursor:pointer;font-size:.8rem;border-bottom:1px solid var(--bdr);line-height:1.4"
          onmouseover="this.style.background='var(--ink3)'" onmouseout="this.style.background=''"
          onclick="_editAddrPick('${branchId}',${i})"
        ><div style="font-weight:600;color:var(--txt)">${_esc(s.mainText)}</div>
         <div style="font-size:.74rem;color:var(--dim);margin-top:.1rem">${_esc(s.secondaryText)}</div></div>`
      ).join('');
      dd.style.display = 'block';
    } catch { dd.style.display = 'none'; }
  }, 300);
}

function _editAddrKeydown(e, branchId) {
  const dd = document.getElementById(`edit-addr-dd-${branchId}`);
  const sugs = _editAddrSuggestions[branchId] || [];
  if (dd.style.display === 'none' || !sugs.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); _editAddrHighlight[branchId] = Math.min((_editAddrHighlight[branchId] || -1) + 1, sugs.length - 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); _editAddrHighlight[branchId] = Math.max((_editAddrHighlight[branchId] || 0) - 1, 0); }
  else if (e.key === 'Enter' && (_editAddrHighlight[branchId] ?? -1) >= 0) { e.preventDefault(); _editAddrPick(branchId, _editAddrHighlight[branchId]); }
  else if (e.key === 'Escape') { dd.style.display = 'none'; }
}

async function _editAddrPick(branchId, i) {
  const dd = document.getElementById(`edit-addr-dd-${branchId}`);
  const s = (_editAddrSuggestions[branchId] || [])[i];
  if (!s) return;
  dd.style.display = 'none';
  const input = document.getElementById(`edit-addr-${branchId}`);
  input.value = s.fullText;
  try {
    const details = await api(`/api/restaurant/places/details?placeId=${encodeURIComponent(s.place_id)}`);
    input.value = details.full_address;
    _editAddrDetails[branchId] = details;
    const conf = document.getElementById(`edit-addr-conf-${branchId}`);
    const parts = [details.area, details.city, details.pincode].filter(Boolean);
    if (parts.length) { conf.textContent = parts.join(', '); conf.style.display = 'block'; }
    document.getElementById(`edit-addr-save-${branchId}`).style.display = '';
  } catch (e) { toast('Could not fetch details: ' + e.message, 'err'); }
}

async function saveBranchAddr(branchId) {
  const d = _editAddrDetails[branchId];
  if (!d || !d.lat || !d.lng) return toast('No valid address selected', 'err');
  const btn = document.getElementById(`edit-addr-save-${branchId}`);
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    await api(`/api/restaurant/branches/${branchId}`, { method: 'PATCH', body: {
      address: d.full_address,
      city: d.city || '',
      pincode: d.pincode || '',
      latitude: d.lat,
      longitude: d.lng,
      area: d.area || '',
      state: d.state || '',
      place_id: d.place_id || '',
    }});
    toast('Address updated!', 'ok');
    loadBranches();
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Save Address'; }
}


// ── Menu page section toggling ──────────────────────────
function toggleAddDropdown() {
  const dd = document.getElementById('menu-add-dropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  // Close on outside click
  if (dd.style.display === 'block') {
    setTimeout(() => document.addEventListener('click', function _close(e) {
      if (!dd.contains(e.target) && e.target.id !== 'menu-add-btn') {
        dd.style.display = 'none';
        document.removeEventListener('click', _close);
      }
    }), 10);
  }
}

function toggleMenuSection(section) {
  const branchForm = document.getElementById('menu-branch-form');
  const branchList = document.getElementById('menu-branch-list-section');
  const uploadSec = document.getElementById('menu-upload-section');
  const catalogPanel = document.getElementById('menu-catalog-panel');
  const addForm = document.getElementById('m-add-form');

  // Close all first
  if (branchForm) branchForm.style.display = 'none';
  if (branchList) branchList.style.display = 'none';
  if (uploadSec) uploadSec.style.display = 'none';
  if (catalogPanel) catalogPanel.style.display = 'none';
  if (addForm && section !== 'item') addForm.style.display = 'none';

  if (section === 'branch') {
    if (branchForm) branchForm.style.display = 'block';
    if (branchList) branchList.style.display = 'block';
    loadBranches();
  } else if (section === 'upload') {
    if (uploadSec) uploadSec.style.display = 'block';
  } else if (section === 'catalog') {
    if (catalogPanel) {
      const isHidden = catalogPanel.style.display === 'none';
      catalogPanel.style.display = isHidden ? 'block' : 'none';
      if (isHidden) {
        // Populate catalog panel with status info
        catalogPanel.innerHTML = '<div style="text-align:center;padding:1rem"><div class="spin"></div></div>';
        loadCatalogPanelContent();
      }
    }
  } else if (section === 'item') {
    if (addForm) {
      addForm.style.display = addForm.style.display === 'none' ? 'block' : 'none';
      // Pre-select the active branch from tabs if one is selected
      const activeBranch = document.getElementById('m-branch').value;
      if (activeBranch && activeBranch !== '__all__' && activeBranch !== '__unassigned__' && branches.length === 1) {
        // Single branch — already selected, no action needed
      } else if (activeBranch && activeBranch !== '__all__' && activeBranch !== '__unassigned__') {
        document.getElementById('m-branch').value = activeBranch;
      }
    }
  }
}

async function loadCatalogPanelContent() {
  const panel = document.getElementById('menu-catalog-panel');
  if (!panel) return;
  try {
    const d = await api('/api/restaurant/catalog/status');
    const catId = d?.mainCatalogId;
    const catName = d?.mainCatalogName || 'Menu Catalog';
    const synced = d?.branches?.reduce((s, b) => s + (b.syncedItems || 0), 0) || 0;
    const total = d?.branches?.reduce((s, b) => s + (b.totalItems || 0), 0) || 0;
    const lastSync = d?.lastFullSync ? new Date(d.lastFullSync).toLocaleString() : 'Never';

    panel.innerHTML = `
      <div class="card">
        <div class="ch" style="justify-content:space-between"><h3>⚙️ Catalog Settings</h3><button class="btn-g btn-sm" onclick="toggleMenuSection(null)">▲ Collapse</button></div>
        <div class="cb">
          ${catId
            ? `<div style="margin-bottom:.7rem">
                <strong>📦 ${catName}</strong> <span style="font-size:.75rem;color:var(--dim)">(${catId})</span><br>
                <span style="font-size:.82rem;color:var(--dim)">Synced: ${synced}/${total} items · Last: ${lastSync}</span>
              </div>`
            : `<div style="margin-bottom:.7rem;color:var(--dim)">No catalog yet — it will be created automatically when you sync.</div>`
          }
          <div style="display:flex;flex-direction:column;gap:.55rem;margin-bottom:.7rem">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:.84rem">Catalog linked</span>
              <label class="tsl"><input type="checkbox" id="toggle-catalog-linked" onchange="toggleCatalogLink(this.checked)" ${d?.catalog_linked ? 'checked' : ''} ${!catId ? 'disabled' : ''}><span class="tsl-track"></span></label>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:.84rem">Cart enabled</span>
              <label class="tsl"><input type="checkbox" id="toggle-cart-enabled" onchange="toggleCatalogCart(this.checked)" ${d?.cart_enabled ? 'checked' : ''} ${!d?.catalog_linked ? 'disabled' : ''}><span class="tsl-track"></span></label>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-size:.84rem">Visible to customers</span>
              <label class="tsl"><input type="checkbox" id="toggle-catalog-visible" onchange="toggleCatalogVisibility(this.checked)" ${d?.catalog_visible ? 'checked' : ''} ${!d?.catalog_linked ? 'disabled' : ''}><span class="tsl-track"></span></label>
            </div>
          </div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap">
            <button class="btn-p btn-sm" onclick="doCatalogSync()">⬆️ Sync to Catalog</button>
            <button class="btn-g btn-sm" onclick="doReverseCatalogSync()">⬇️ Pull from Catalog</button>
            <button class="btn-g btn-sm" onclick="doClearAndResync()" style="color:var(--red);border-color:var(--red)" title="Delete all items from Meta catalog and re-upload">🔄 Clear & Re-sync</button>
          </div>
          <div id="collection-status" style="margin-top:1rem;border-top:1px solid var(--bdr);padding-top:.8rem">
            <div style="font-size:.82rem;font-weight:600;margin-bottom:.5rem">Branch Collections</div>
            <div id="collection-list" style="font-size:.82rem;color:var(--dim)">Loading...</div>
            <button class="btn-g btn-sm" style="margin-top:.5rem" onclick="doSyncBranchCollections()">🔄 Sync Collections</button>
          </div>
        </div>
      </div>`;
    loadCollectionStatus();
  } catch (e) {
    panel.innerHTML = `<div class="card"><div class="cb" style="color:var(--red)">Failed to load catalog status: ${e.message}</div></div>`;
  }
}

async function loadBranchSel() {
  const sel = document.getElementById('m-branch');
  try {
    const data = await api('/api/restaurant/branches');
    branches = data || [];
    const prevVal = sel.value;
    sel.innerHTML = '<option value="__all__">All Branches</option>' +
      branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('') +
      '<option value="__unassigned__">⚠️ Unassigned</option>';
    // Restore persisted branch selection, or default to __all__
    const savedBranch = localStorage.getItem('gb_selected_branch');
    const effectivePrev = prevVal || savedBranch;
    if (effectivePrev && (effectivePrev === '__all__' || effectivePrev === '__unassigned__' || branches.some(b => b.id === effectivePrev))) {
      sel.value = effectivePrev;
    } else {
      sel.value = '__all__';
    }
    localStorage.setItem('gb_selected_branch', sel.value);

    // Render branch tabs for multi-branch restaurants
    const tabsDiv = document.getElementById('branch-tabs');
    if (branches.length > 1) {
      const inner = tabsDiv.querySelector('div');
      inner.innerHTML =
        `<button class="btn-g btn-sm branch-tab ${sel.value === '__all__' ? 'act' : ''}" onclick="selectBranchTab('__all__',this)" style="font-size:.78rem;padding:.3rem .7rem;border-radius:6px">All</button>` +
        branches.map(b => `<button class="btn-g btn-sm branch-tab ${sel.value === b.id ? 'act' : ''}" onclick="selectBranchTab('${b.id}',this)" style="font-size:.78rem;padding:.3rem .7rem;border-radius:6px">${b.name}</button>`).join('');
      tabsDiv.style.display = '';
      sel.style.display = 'none';
    } else {
      tabsDiv.style.display = 'none';
      sel.style.display = branches.length === 1 ? 'none' : '';
      if (branches.length === 1) { sel.value = branches[0].id; }
    }

    renderCatalogBar();
    loadMenu();
  } catch (_) {}
}

function selectBranchTab(branchId, btn) {
  const sel = document.getElementById('m-branch');
  sel.value = branchId;
  localStorage.setItem('gb_selected_branch', branchId);
  document.querySelectorAll('.branch-tab').forEach(b => b.classList.remove('act'));
  if (btn) btn.classList.add('act');
  // Update branch summary
  const summary = document.getElementById('branch-summary');
  if (branchId && branchId !== '__all__' && branchId !== '__unassigned__') {
    const b = branches.find(x => x.id === branchId);
    if (b) {
      document.getElementById('bs-name').textContent = b.name;
      document.getElementById('bs-addr').textContent = b.address || b.city || '';
      document.getElementById('bs-status').innerHTML = b.is_open ? '<span style="color:var(--wa)">Open</span>' : '<span style="color:var(--red)">Closed</span>';
      summary.style.display = '';
    }
  } else { summary.style.display = 'none'; }
  loadMenu();
}
function doSelectBranch(id) {
  const sel = document.getElementById('m-branch');
  if (sel) { sel.value = id; loadMenu(); }
}
let _allMenuData = null; // cached data for client-side filtering
let _menuItems = []; // flat list of current menu items for bulk operations

async function loadMenu() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId) return;

  const isAll = branchId === '__all__';
  const isUnassigned = branchId === '__unassigned__';
  const isSpecificBranch = !isAll && !isUnassigned;

  // Load categories for add-item dropdown (specific branch only)
  if (isSpecificBranch) {
    const cats = await api(`/api/restaurant/branches/${branchId}/categories`).catch(() => []);
    const catSel = document.getElementById('m-cat');
    catSel.innerHTML = '<option value="">No category</option>' +
      (cats || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('') +
      '<option value="__new__">+ New category…</option>';
    document.getElementById('m-cat-new').style.display = 'none';
    document.getElementById('m-cat-new').value = '';
    if (_catManagerOpen) renderCatList();
  }

  const branch = isSpecificBranch ? branches.find(b => b.id === branchId) : null;
  const badge = document.getElementById('m-cat-badge');
  const syncBtn = document.getElementById('m-sync-btn');
  badge.style.display = isSpecificBranch ? 'flex' : 'none';
  syncBtn.style.display = (isSpecificBranch && branch?.catalog_id) ? 'inline-flex' : 'none';
  const setsBtn = document.getElementById('m-sets-btn');
  if (setsBtn) setsBtn.style.display = (isSpecificBranch && branch?.catalog_id) ? 'inline-flex' : 'none';
  const bulkImgBtn = document.getElementById('m-bulk-img-btn');
  if (bulkImgBtn) bulkImgBtn.style.display = isSpecificBranch ? 'inline-flex' : 'none';
  if (isSpecificBranch) loadImageStats();

  if (isSpecificBranch) {
    badge.innerHTML = branch?.catalog_id
      ? `<span class="badge bg">✅ Catalog Live</span><button class="btn-g btn-sm" onclick="doFixCatalog()" title="Re-discover catalog from Meta if sync fails" style="font-size:.7rem;padding:.25rem .55rem;margin-left:.35rem">🔧 Fix Catalog</button>`
      : `<span class="badge ba">⚠️ No catalog — <button onclick="goTab('branches',null)" style="background:none;border:none;color:var(--gold2);cursor:pointer;font-size:.72rem;text-decoration:underline">create in Branches</button></span>`;
  }

  const list = document.getElementById('menu-list');
  list.innerHTML = `<div style="text-align:center;padding:2rem"><div class="spin"></div></div>`;

  try {
    let grouped, totalItems, unassignedCount = 0;

    if (isUnassigned) {
      // Fetch unassigned items
      const items = await api('/api/restaurant/menu/unassigned');
      grouped = items?.length ? [{ id: null, name: 'Unassigned Items', items }] : [];
      totalItems = items?.length || 0;
    } else if (isAll) {
      const data = await api('/api/restaurant/menu/all');
      // New response format: { groups, unassigned_count, total_count }
      grouped = data?.groups || data; // backwards-compatible
      totalItems = data?.total_count || grouped?.reduce((s, g) => s + (g.items?.length || 0), 0) || 0;
      unassignedCount = data?.unassigned_count || 0;
    } else {
      grouped = await api(`/api/restaurant/branches/${branchId}/menu`);
      totalItems = grouped?.reduce((s, g) => s + (g.items?.length || 0), 0) || 0;
    }

    _allMenuData = isAll ? grouped : null;

    const countEl = document.getElementById('m-item-count');
    if (countEl) {
      let txt = '';
      if (isAll) txt = `Showing all ${totalItems} items` + (unassignedCount ? ` · ${unassignedCount} unassigned` : '');
      else if (isUnassigned) txt = `${totalItems} unassigned items`;
      else txt = totalItems ? `${totalItems} items` : '';
      countEl.textContent = txt;
    }
    // Update branch summary count
    const bsCount = document.getElementById('bs-count');
    if (bsCount && !isAll && !isUnassigned) {
      bsCount.textContent = `${totalItems} items`;
    }

    // Update branch selector and tabs with item counts (only when loading all)
    if (isAll && branches.length) {
      const allItems = (Array.isArray(grouped) ? grouped : []).flatMap(g => g.items || []);
      const sel = document.getElementById('m-branch');
      sel.innerHTML = `<option value="__all__">All Branches (${totalItems})</option>` +
        branches.map(b => {
          const cnt = allItems.filter(i => i.branch_id === b.id).length;
          return `<option value="${b.id}">${b.name} (${cnt})</option>`;
        }).join('') +
        (unassignedCount ? `<option value="__unassigned__">⚠️ Unassigned (${unassignedCount})</option>` : '<option value="__unassigned__">⚠️ Unassigned</option>');
      sel.value = '__all__';
      // Update tab counts
      if (branches.length > 1) {
        const inner = document.getElementById('branch-tabs')?.querySelector('div');
        if (inner) {
          inner.innerHTML =
            `<button class="btn-g btn-sm branch-tab act" onclick="selectBranchTab('__all__',this)" style="font-size:.78rem;padding:.3rem .7rem;border-radius:6px">All (${totalItems})</button>` +
            branches.map(b => {
              const cnt = allItems.filter(i => i.branch_id === b.id).length;
              return `<button class="btn-g btn-sm branch-tab" onclick="selectBranchTab('${b.id}',this)" style="font-size:.78rem;padding:.3rem .7rem;border-radius:6px">${b.name} (${cnt})</button>`;
            }).join('');
        }
      }
    }

    if (!grouped?.length || grouped.every(g => !g.items?.length)) {
      const emptyMsg = isUnassigned
        ? '<div class="empty"><div class="ei">✅</div><h3>No unassigned items</h3><p>All items are assigned to branches</p></div>'
        : '<div class="empty"><div class="ei">🍽️</div><h3>No menu items yet</h3><p>Add items using the "+ Add" button above</p></div>';
      list.innerHTML = emptyMsg;
      return;
    }

    // Show bulk assign bar for unassigned view
    const bulkAssignHtml = isUnassigned && totalItems > 0
      ? `<div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.8rem;padding:.6rem .8rem;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;font-size:.82rem">
           <span>⚠️ ${totalItems} items need branch assignment</span>
           <select id="bulk-assign-branch" style="margin-left:auto;padding:.3rem .5rem;border-radius:6px;border:1px solid var(--rim);font-size:.8rem">
             <option value="">Assign to...</option>
             ${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
           </select>
           <button class="btn-p btn-sm" onclick="doBulkAssignAll()">Assign All</button>
         </div>`
      : '';

    // Store flat items for bulk availability
    _menuItems = (grouped || []).flatMap(g => g.items || []);
    const availCount = _menuItems.filter(i => i.is_available).length;
    _updateBulkAvailBtn(availCount > 0);

    list.innerHTML = bulkAssignHtml + renderMenuGroups(grouped, isAll || isUnassigned);
  } catch (e) { toast('Failed to load menu: ' + e.message, 'err'); }

  if (isSpecificBranch) {
    loadProductSets();
    loadCollections();
  }
}

function renderMenuGroups(grouped, showBranchBadge) {
  // Flatten all items with category info for table display
  const allItems = [];
  for (const g of grouped) {
    for (const item of (g.items || [])) {
      allItems.push({ ...item, _categoryName: g.name || 'Uncategorized' });
    }
  }
  if (!allItems.length) return '';

  // FSSAI-style food type indicator — bordered square with filled dot inside
  function foodTypeIndicator(foodType) {
    const cfg = {
      veg:     { border: '#22C55E', dot: '#22C55E', label: 'Veg',     inner: null },
      non_veg: { border: '#DC2626', dot: '#DC2626', label: 'Non-Veg', inner: null },
      egg:     { border: '#EAB308', dot: '#EAB308', label: 'Egg',     inner: null },
      vegan:   { border: '#16A34A', dot: '#16A34A', label: 'Vegan',   inner: 'V' },
    };
    const c = cfg[foodType] || { border: '#9CA3AF', dot: '#9CA3AF', label: 'Not set', inner: null };
    const innerEl = c.inner
      ? `<span style="color:${c.dot};font-size:8px;font-weight:800;line-height:1">${c.inner}</span>`
      : `<span style="width:7px;height:7px;border-radius:50%;background:${c.dot};display:block"></span>`;
    return `<span title="${c.label}" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:2px solid ${c.border};border-radius:2px;box-sizing:border-box;vertical-align:middle">${innerEl}</span>`;
  }
  const branchCol = showBranchBadge ? '<th style="padding:.55rem .7rem;text-align:left;font-size:.77rem;font-weight:600;color:var(--dim)">Branch</th>' : '';
  const branchColCount = showBranchBadge ? 1 : 0;

  let rows = allItems.map((item, idx) => {
    const safeName = item.name.replace(/'/g, "\\'");
    const typeIcon = foodTypeIndicator(item.food_type);
    const displayName = item.item_group_id
      ? `${item.name} <span style="font-size:.72rem;color:var(--acc);font-weight:500">· ${item.size || item.variant_value || 'Variant'}</span>`
      : item.name;
    const price = item.sale_price_paise
      ? `<span style="text-decoration:line-through;color:var(--mute);font-size:.75rem">₹${item.price_paise/100}</span> <span style="color:#dc2626;font-weight:600">₹${item.sale_price_paise/100}</span>`
      : `₹${item.price_paise/100}`;
    const branchTd = showBranchBadge
      ? `<td style="padding:.45rem .7rem;font-size:.78rem;color:var(--dim)">${item.branch_name || '—'}</td>`
      : '';
    const rowBg = idx % 2 === 0 ? '' : 'background:var(--ink4,#f9fafb);';

    const dimStyle = item.is_available ? '' : 'opacity:.55;';

    return `<tr id="mi-row-${item.id}" style="${rowBg}${dimStyle}">
      <td style="padding:.45rem .4rem;text-align:center;width:32px"><input type="checkbox" class="mi-check" data-id="${item.id}" data-name="${safeName}" onchange="updateBulkBar()"></td>
      <td style="padding:.45rem .7rem;font-size:.78rem;color:var(--dim);text-align:center;width:40px">${idx + 1}</td>
      <td style="padding:.45rem .7rem;font-size:.82rem;font-weight:500">${displayName}${item.is_bestseller ? ' <span style="font-size:.6rem;color:#f59e0b">⭐</span>' : ''}${item.is_available ? '' : ' <span style="font-size:.65rem;color:#9ca3af;font-weight:400">(unavailable)</span>'}</td>
      <td style="padding:.45rem .7rem;font-size:.78rem;color:var(--dim)">${item._categoryName}</td>
      ${branchTd}
      <td style="padding:.45rem .7rem;font-size:.82rem;text-align:center">${typeIcon}</td>
      <td style="padding:.45rem .7rem;font-size:.82rem;font-weight:500;text-align:right;white-space:nowrap">${price}</td>
      <td style="padding:.45rem .7rem;text-align:center">
        <label class="tsl" style="margin:0"><input type="checkbox" id="avail-${item.id}" ${item.is_available ? 'checked' : ''} onchange="doToggleItem('${item.id}',this.checked,'${safeName}')"><div class="tsl-track"></div></label>
      </td>
      <td style="padding:.45rem .7rem;text-align:center">
        <button onclick="doDeleteItem('${item.id}','${safeName}')" title="Delete ${safeName}" style="background:none;border:none;cursor:pointer;font-size:.85rem;color:#9ca3af;transition:color .15s" onmouseover="this.style.color='#dc2626'" onmouseout="this.style.color='#9ca3af'">🗑️</button>
      </td>
    </tr>`;
  }).join('');

  return `<div class="card" style="margin-bottom:.9rem;overflow:hidden">
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:.84rem;font-family:var(--font-body,'Inter',sans-serif)">
        <thead>
          <tr style="background:#f9fafb;border-bottom:2px solid var(--rim,#e5e7eb)">
            <th style="padding:.55rem .4rem;text-align:center;width:32px"><input type="checkbox" onchange="toggleAllMenuItems(this.checked)"></th>
            <th style="padding:.55rem .7rem;text-align:center;font-size:.77rem;font-weight:600;color:var(--dim);width:40px">#</th>
            <th style="padding:.55rem .7rem;text-align:left;font-size:.77rem;font-weight:600;color:var(--dim)">Item Name</th>
            <th style="padding:.55rem .7rem;text-align:left;font-size:.77rem;font-weight:600;color:var(--dim)">Category</th>
            ${branchCol}
            <th style="padding:.55rem .7rem;text-align:center;font-size:.77rem;font-weight:600;color:var(--dim);width:60px">Type</th>
            <th style="padding:.55rem .7rem;text-align:right;font-size:.77rem;font-weight:600;color:var(--dim);width:90px">Price</th>
            <th style="padding:.55rem .7rem;text-align:center;font-size:.77rem;font-weight:600;color:var(--dim);width:70px">Status</th>
            <th style="padding:.55rem .7rem;text-align:center;font-size:.77rem;font-weight:600;color:var(--dim);width:55px"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

/* ═══ FUTURE FEATURE: Card-based menu item display ═══
   The original card/row layout for menu items. Replaced by table format.
   Kept as reference for potential mobile-optimized view.

   function miRow(item, isGroupedVariant, showBranchBadge) {
     const ti = { veg: '🟢', non_veg: '🔴', vegan: '🌱', egg: '🟡' };
     const thumbSrc = item.thumbnail_url || item.image_url;
     const thumb = thumbSrc
       ? '<img class="mi-th" src="' + thumbSrc + '" onerror="this.style.display=\'none\'">'
       : '<div class="mi-ph">' + (ti[item.food_type] || '🍽️') + '</div>';
     const variantBadge = item.item_group_id
       ? '<span class="var-badge" title="Part of a variant group">⚡ ' + (item.size || item.variant_value || 'Variant') + '</span>'
       : '';
     const branchBadge = (showBranchBadge && item.branch_name && !isGroupedVariant)
       ? '<span style="font-size:.62rem;background:#e0e7ff;padding:.1rem .4rem;border-radius:10px;color:#4338ca;margin-left:.3rem">' + item.branch_name + '</span>'
       : '';
     const saleBadge = item.sale_price_paise
       ? '<span style="text-decoration:line-through;color:var(--mute);font-size:.75rem;margin-right:.3rem">₹' + (item.price_paise / 100) + '</span><span style="color:var(--red);font-weight:600">₹' + (item.sale_price_paise / 100) + '</span>'
       : '₹' + (item.price_paise / 100);
     const syncDot = item.catalog_sync_status === 'synced' ? '🟢' : item.catalog_sync_status === 'error' ? '🔴' : '🟡';
     const safeName = item.name.replace(/'/g, "\\'");
     const indent = isGroupedVariant ? 'padding-left:1.8rem;' : '';
     return '<div class="mi" style="' + indent + '">' + thumb + '<div style="flex:1;min-width:0"><div class="mi-name">' + (isGroupedVariant ? '' : item.name) + (isGroupedVariant ? (item.size || item.variant_value || 'Variant') : '') + '</div></div><div class="mi-price">' + saleBadge + '</div><div class="mi-acts"><label class="tsl"><input type="checkbox" ' + (item.is_available ? 'checked' : '') + ' onchange="doToggleItem(\'' + item.id + '\',this.checked,\'' + safeName + '\')"><div class="tsl-track"></div></label><button class="btn-del" onclick="doDeleteItem(\'' + item.id + '\',\'' + safeName + '\')">🗑</button></div></div>';
   }
   ═══ END FUTURE FEATURE ═══ */

let _catManagerOpen = false;
function toggleCatManager() {
  _catManagerOpen = !_catManagerOpen;
  document.getElementById('cat-manager-body').style.display = _catManagerOpen ? 'block' : 'none';
  document.getElementById('cat-manager-toggle').textContent = _catManagerOpen ? '▲ collapse' : '▼ expand';
  if (_catManagerOpen) renderCatList();
}
async function renderCatList() {
  const branchId = document.getElementById('m-branch').value;
  const area = document.getElementById('cat-list-area');
  if (!branchId) { area.innerHTML = '<p style="color:var(--dim);font-size:.82rem">Select a branch first.</p>'; return; }
  try {
    const cats = await api(`/api/restaurant/branches/${branchId}/categories`);
    if (!cats?.length) {
      area.innerHTML = '<p style="color:var(--dim);font-size:.82rem">No categories yet. Add one above.</p>';
      return;
    }
    area.innerHTML = `<div style="display:flex;flex-direction:column;gap:.4rem">
      ${cats.map(c => `
        <div id="cat-row-${c.id}" style="display:flex;gap:.5rem;align-items:center;padding:.38rem .5rem;background:var(--ink2);border-radius:7px">
          <span id="cat-lbl-${c.id}" style="flex:1;font-size:.84rem">${c.name}</span>
          <input id="cat-edit-${c.id}" value="${c.name}" style="display:none;flex:1;padding:.28rem .5rem;background:var(--ink3);border:1px solid var(--bdr);border-radius:6px;color:var(--fg);font-size:.84rem" onkeydown="if(event.key==='Enter')saveCat('${c.id}');if(event.key==='Escape')cancelEditCat('${c.id}')">
          <button class="btn-g btn-sm" onclick="startEditCat('${c.id}')" id="cat-ebtn-${c.id}" style="padding:.25rem .55rem;font-size:.75rem">✏ Edit</button>
          <button class="btn-p btn-sm" onclick="saveCat('${c.id}')" id="cat-sbtn-${c.id}" style="display:none;padding:.25rem .55rem;font-size:.75rem">Save</button>
          <button class="btn-g btn-sm" onclick="cancelEditCat('${c.id}')" id="cat-cbtn-${c.id}" style="display:none;padding:.25rem .55rem;font-size:.75rem">Cancel</button>
          <button onclick="doDeleteCat('${c.id}','${c.name.replace(/'/g,"\\'")}',this)" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:1rem;padding:0 .2rem" title="Delete">🗑</button>
        </div>`).join('')}
    </div>`;
  } catch (e) { area.innerHTML = `<p style="color:var(--red);font-size:.82rem">${e.message}</p>`; }
}
async function doCreateCat() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId) return toast('Select a branch first', 'err');
  const name = document.getElementById('cat-new-name').value.trim();
  if (!name) return toast('Enter a category name', 'err');
  try {
    const cat = await api(`/api/restaurant/branches/${branchId}/categories`, { method: 'POST', body: { name } });
    document.getElementById('cat-new-name').value = '';
    // Add to dropdown
    const sel = document.getElementById('m-cat');
    const opt = new Option(cat.name, cat.id);
    sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
    toast(`Category "${name}" created`, 'ok');
    renderCatList();
  } catch (e) { toast(e.message, 'err'); }
}
function startEditCat(id) {
  document.getElementById('cat-lbl-' + id).style.display = 'none';
  document.getElementById('cat-edit-' + id).style.display = 'block';
  document.getElementById('cat-edit-' + id).focus();
  document.getElementById('cat-ebtn-' + id).style.display = 'none';
  document.getElementById('cat-sbtn-' + id).style.display = 'inline-flex';
  document.getElementById('cat-cbtn-' + id).style.display = 'inline-flex';
}
function cancelEditCat(id) {
  document.getElementById('cat-lbl-' + id).style.display = '';
  document.getElementById('cat-edit-' + id).style.display = 'none';
  document.getElementById('cat-ebtn-' + id).style.display = 'inline-flex';
  document.getElementById('cat-sbtn-' + id).style.display = 'none';
  document.getElementById('cat-cbtn-' + id).style.display = 'none';
}
async function saveCat(id) {
  const branchId = document.getElementById('m-branch').value;
  const name = document.getElementById('cat-edit-' + id).value.trim();
  if (!name) return toast('Category name cannot be empty', 'err');
  try {
    await api(`/api/restaurant/branches/${branchId}/categories/${id}`, { method: 'PUT', body: { name } });
    // Update dropdown option
    const opt = document.querySelector(`#m-cat option[value="${id}"]`);
    if (opt) opt.textContent = name;
    toast(`Renamed to "${name}"`, 'ok');
    renderCatList();
  } catch (e) { toast(e.message, 'err'); }
}
async function doDeleteCat(id, name, btn) {
  if (!confirm(`Delete category "${name}"? Items in this category will become uncategorized.`)) return;
  const branchId = document.getElementById('m-branch').value;
  btn.disabled = true;
  try {
    await api(`/api/restaurant/branches/${branchId}/categories/${id}`, { method: 'DELETE' });
    // Remove from dropdown
    document.querySelector(`#m-cat option[value="${id}"]`)?.remove();
    toast(`"${name}" deleted`, 'ok');
    renderCatList();
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
}


const VARIANT_PRESETS = {
  Size:    ['Small', 'Medium', 'Large'],
  Portion: ['Half', 'Full'],
  Pack:    ['Single', 'Family', 'Party Pack'],
  Custom:  ['Option 1', 'Option 2'],
};
function onVariantToggle(cb) {
  const on = cb.checked;
  document.getElementById('m-variants-section').style.display = on ? 'block' : 'none';
  document.getElementById('m-price-row').style.display = on ? 'none' : '';
  if (on && !document.getElementById('m-variant-rows').children.length) {
    const type = document.getElementById('m-variant-type').value;
    (VARIANT_PRESETS[type] || ['Option 1']).forEach(v => addVariantRow(v));
  }
}
function addVariantRow(name = '') {
  const rows = document.getElementById('m-variant-rows');
  const idx  = rows.children.length;
  const div  = document.createElement('div');
  div.style.cssText = 'display:flex;gap:.4rem;align-items:center';
  div.innerHTML = `
    <input placeholder="Variant name (e.g. Small)" value="${name}"
      style="flex:1.4;padding:.42rem .6rem;background:var(--ink2);border:1px solid var(--bdr);border-radius:7px;color:var(--fg);font-size:.84rem"
      class="vr-name">
    <input type="number" placeholder="Price ₹"
      style="flex:1;padding:.42rem .6rem;background:var(--ink2);border:1px solid var(--bdr);border-radius:7px;color:var(--fg);font-size:.84rem"
      class="vr-price">
    <button type="button" onclick="this.parentElement.remove()"
      style="background:none;border:none;color:var(--red);font-size:1.1rem;cursor:pointer;padding:0 .2rem" title="Remove">×</button>`;
  rows.appendChild(div);
}

function onCatChange(sel) {
  const newInput = document.getElementById('m-cat-new');
  if (sel.value === '__new__') {
    newInput.style.display = 'block';
    newInput.focus();
  } else {
    newInput.style.display = 'none';
    newInput.value = '';
  }
}
async function doAddItem() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId || branchId === '__all__') return toast('Select a specific branch first to add items', 'err');
  const name = document.getElementById('m-name').value.trim();
  if (!name) return toast('Item name is required', 'err');

  // Resolve category
  let categoryId = document.getElementById('m-cat').value || null;
  if (categoryId === '__new__') {
    const newCatName = document.getElementById('m-cat-new').value.trim();
    if (!newCatName) return toast('Enter a category name', 'err');
    try {
      const cat = await api(`/api/restaurant/branches/${branchId}/categories`, { method: 'POST', body: { name: newCatName } });
      categoryId = cat.id;
      const sel = document.getElementById('m-cat');
      const opt = new Option(newCatName, cat.id, true, true);
      sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
      sel.value = cat.id;
      document.getElementById('m-cat-new').style.display = 'none';
      document.getElementById('m-cat-new').value = '';
    } catch (e) { return toast('Could not create category: ' + e.message, 'err'); }
  }

  // Collect advanced Meta fields
  const advGroupId  = (document.getElementById('m-group-id')?.value || '').trim() || undefined;
  const advSize     = (document.getElementById('m-size')?.value || '').trim() || undefined;
  const advSalePrice= document.getElementById('m-sale-price')?.value || undefined;
  const advStockQty = document.getElementById('m-stock-qty')?.value || undefined;
  const advTagsRaw  = (document.getElementById('m-tags')?.value || '').trim();
  const advTags     = advTagsRaw ? advTagsRaw.split(',').map(t => t.trim()).filter(Boolean) : undefined;

  const common = {
    description: document.getElementById('m-desc').value,
    foodType:    document.getElementById('m-type').value,
    categoryId,
    imageUrl:    document.getElementById('m-img').value,
    ...(_lastUploadedThumb && { thumbnailUrl: _lastUploadedThumb }),
    ...(_lastUploadedS3Key && { imageS3Key: _lastUploadedS3Key }),
    ...(advGroupId  && { itemGroupId: advGroupId }),
    ...(advSize     && { size: advSize }),
    ...(advSalePrice && { salePriceRs: parseFloat(advSalePrice) }),
    ...(advStockQty && { quantityToSellOnFacebook: parseInt(advStockQty) }),
    ...(advTags     && { productTags: advTags }),
  };

  const hasVariants = document.getElementById('m-has-variants').checked;

  try {
    if (hasVariants) {
      // Collect variant rows
      const rows = [...document.getElementById('m-variant-rows').querySelectorAll('div')];
      const variants = rows.map(r => ({
        name:  r.querySelector('.vr-name').value.trim(),
        price: parseFloat(r.querySelector('.vr-price').value),
      })).filter(v => v.name && !isNaN(v.price) && v.price > 0);
      if (!variants.length) return toast('Add at least one variant with a name and price', 'err');

      // Shared itemGroupId groups all variants together
      const groupId = `GRP-${Date.now()}`;
      const variantType = document.getElementById('m-variant-type').value;
      for (const v of variants) {
        await api(`/api/restaurant/branches/${branchId}/menu`, { method: 'POST', body: {
          ...common, name, priceRs: v.price,
          itemGroupId: groupId, variantType, variantValue: v.name,
        }});
      }
      toast(`"${name}" added with ${variants.length} variants! Click Sync to push.`, 'ok');
    } else {
      const price = document.getElementById('m-price').value;
      if (!price) return toast('Price is required', 'err');
      await api(`/api/restaurant/branches/${branchId}/menu`, { method: 'POST', body: {
        ...common, name, priceRs: parseFloat(price),
      }});
      toast(`"${name}" added! Click Sync to push to WhatsApp.`, 'ok');
    }

    // Reset form
    ['m-name', 'm-price', 'm-desc', 'm-group-id', 'm-size', 'm-sale-price', 'm-stock-qty', 'm-tags'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('m-has-variants').checked = false;
    document.getElementById('m-variants-section').style.display = 'none';
    document.getElementById('m-price-row').style.display = '';
    document.getElementById('m-variant-rows').innerHTML = '';
    resetImgPicker();
    // Collapse the add form after successful add
    toggleMenuSection(null);
    loadMenu();
  } catch (e) { toast(e.message, 'err'); }
}
async function doQuickSync() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId) return;
  const branch = branches.find(b => b.id === branchId);
  if (!branch?.catalog_id) return toast('No catalog yet — create it in Branches tab first', 'err');
  const btn = document.getElementById('m-sync-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Syncing...';
  try {
    const r = await api(`/api/restaurant/branches/${branchId}/sync-catalog`, { method: 'POST' });
    if (r.success) toast(`✅ ${r.updated} items now live on WhatsApp!`, 'ok');
    else toast(r.errors?.[0] || 'Sync failed', 'err');
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '🔄 Sync to WhatsApp'; }
}


async function doSyncToCatalog() {
  const btn = document.getElementById('sync-to-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spin" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle"></div> Syncing...';
  try {
    const r = await api('/api/restaurant/catalog/sync', { method: 'POST' });
    const synced = r.totalSynced || 0;
    const failed = r.totalFailed || 0;
    if (failed === 0) { btn.innerHTML = '⬆ Synced ✅'; btn.style.color = 'var(--wa)'; }
    else { btn.innerHTML = `⬆ Synced ⚠️ (${synced}/${synced + failed})`; btn.style.color = '#d97706'; }
    toast(`${synced} items synced to catalog${failed ? `, ${failed} failed` : ''}`, failed ? 'err' : 'ok');
    updateSyncStatus();
    setTimeout(() => { btn.innerHTML = '⬆ Sync to Catalog'; btn.style.color = ''; }, 4000);
  } catch (e) {
    btn.innerHTML = '⬆ Sync Failed ❌'; btn.style.color = 'var(--red)';
    toast(e.message, 'err');
    setTimeout(() => { btn.innerHTML = '⬆ Sync to Catalog'; btn.style.color = ''; }, 5000);
  } finally { btn.disabled = false; }
}

async function doSyncFromCatalog() {
  const btn = document.getElementById('sync-from-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spin" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:middle"></div> Pulling...';
  try {
    const r = await api('/api/restaurant/catalog/reverse-sync', { method: 'POST' });
    const total = (r.new_items_added || 0) + (r.existing_items_updated || 0);
    btn.innerHTML = '⬇ Pulled ✅'; btn.style.color = 'var(--wa)';
    toast(`${r.new_items_added || 0} new, ${r.existing_items_updated || 0} updated from catalog`, 'ok');
    updateSyncStatus();
    loadMenu();
    setTimeout(() => { btn.innerHTML = '⬇ Sync from Catalog'; btn.style.color = ''; }, 4000);
  } catch (e) {
    btn.innerHTML = '⬇ Pull Failed ❌'; btn.style.color = 'var(--red)';
    toast(e.message, 'err');
    setTimeout(() => { btn.innerHTML = '⬇ Sync from Catalog'; btn.style.color = ''; }, 5000);
  } finally { btn.disabled = false; }
}

function updateSyncStatus() {
  api('/api/restaurant/catalog/sync-status').then(s => {
    const line = document.getElementById('sync-status-line');
    const text = document.getElementById('sync-last-text');
    if (!s) return;
    const parts = [];
    if (s.lastSyncToMeta) parts.push('⬆ ' + timeAgoShort(s.lastSyncToMeta));
    if (s.lastSyncFromMeta) parts.push('⬇ ' + timeAgoShort(s.lastSyncFromMeta));
    if (parts.length) { text.textContent = 'Last sync: ' + parts.join(' · '); line.style.display = ''; }
  }).catch(() => {});
}

function timeAgoShort(ts) {
  const secs = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

async function doFixCatalog() {
  const sel = document.getElementById('m-branch');
  const branchId = sel?.value;
  if (!branchId) return toast('Select a branch first', 'err');

  // First try auto-discovery
  try {
    toast('Re-discovering catalog from Meta…', 'nfo');
    const r = await api(`/api/restaurant/branches/${branchId}/fix-catalog`, { method: 'POST' });
    if (r.catalogId) {
      toast(`✅ Catalog fixed! ID: ${r.catalogId} — try syncing again`, 'ok');
      branches = await api('/api/restaurant/branches');
      await loadMenu(branchId);
      return;
    }
  } catch (_) {}

  // Auto-discovery failed — ask user to paste the catalog ID manually
  const manualId = prompt(
    'Auto-discovery failed.\n\nTo find your Catalog ID:\n1. Go to Meta Business Suite → Commerce Manager\n2. Select your catalog → Settings\n3. Copy the numeric Catalog ID\n\nPaste it here:'
  );
  if (!manualId?.trim()) return;
  try {
    await api(`/api/restaurant/branches/${branchId}`, { method: 'PATCH', body: { catalogId: manualId.trim() } });
    toast(`✅ Catalog ID saved — try syncing now`, 'ok');
    branches = await api('/api/restaurant/branches');
    await loadMenu(branchId);
  } catch (e) { toast(e.message, 'err'); }
}
async function doToggleItem(id, av, name) {
  // Optimistic UI update — dim/undim row immediately
  var row = document.getElementById('mi-row-' + id);
  if (row) row.style.opacity = av ? '' : '.55';

  var hasMultipleBranches = (branches || []).length > 1;
  var applyAllBranches = false;

  // When toggling OFF with multiple branches, check if same dish exists elsewhere
  if (hasMultipleBranches && !av) {
    var currentItem = (_menuItems || []).find(function(i) { return i.id === id; });
    var currentBranch = currentItem ? currentItem.branch_id : null;
    var sameName = (_menuItems || []).filter(function(i) {
      return i.id !== id && i.branch_id !== currentBranch && i.name && i.name.toLowerCase() === name.toLowerCase() && i.is_available;
    });
    if (sameName.length > 0) {
      var branchNames = sameName.map(function(i) { var b = (branches || []).find(function(br) { return br.id === i.branch_id; }); return b ? b.name : 'Other branch'; });
      var uniqueBranches = branchNames.filter(function(v, i, a) { return a.indexOf(v) === i; });
      applyAllBranches = confirm('"' + name + '" is also available at ' + uniqueBranches.join(', ') + '.\n\nMark it unavailable at ALL branches?');
    }
  }

  try {
    if (applyAllBranches) {
      var r = await api('/api/restaurant/menu/' + id + '/availability-all-branches', { method: 'PATCH', body: { available: av } });
      toast('"' + name + '" marked unavailable at ' + r.affected_branches + ' branch' + (r.affected_branches > 1 ? 'es' : '') + ' \u2014 syncing to WhatsApp...', 'ok');
      loadMenu();
    } else {
      await api('/api/restaurant/menu/' + id + '/availability', { method: 'PATCH', body: { available: av } });
      toast('"' + name + '" ' + (av ? 'back on menu' : 'marked unavailable') + ' \u2014 syncing to WhatsApp...', 'ok');
      var mi = (_menuItems || []).find(function(i) { return i.id === id; });
      if (mi) mi.is_available = av;
      // Info toast when toggling ON and same dish is off at other branches
      if (av && hasMultipleBranches) {
        var cur = (_menuItems || []).find(function(i) { return i.id === id; });
        var curBr = cur ? cur.branch_id : null;
        var sameOff = (_menuItems || []).filter(function(i) { return i.id !== id && i.branch_id !== curBr && i.name && i.name.toLowerCase() === name.toLowerCase() && !i.is_available; });
        if (sameOff.length > 0) toast('"' + name + '" is still unavailable at ' + sameOff.length + ' other branch' + (sameOff.length > 1 ? 'es' : ''), 'nfo');
      }
    }
  } catch (e) {
    // Revert toggle and row opacity on error
    var cb = document.getElementById('avail-' + id);
    if (cb) cb.checked = !av;
    if (row) row.style.opacity = !av ? '' : '.55';
    toast(e.message, 'err');
  }
}
async function doBulkAvailability() {
  const rawBranch = document.getElementById('m-branch')?.value || '';
  // Only use real branch IDs — skip __all__ and __unassigned__
  const branchId = (rawBranch && !rawBranch.startsWith('__')) ? rawBranch : '';
  const branchLabel = branchId ? (branches.find(b => b.id === branchId)?.name || 'this branch') : 'all branches';
  // Determine current state — check if majority of items are available
  const items = _menuItems || [];
  const branchItems = branchId ? items.filter(i => i.branch_id === branchId) : items;
  const availCount = branchItems.filter(i => i.is_available).length;
  const isClosing = availCount > 0;
  const label = isClosing
    ? `Mark all ${branchItems.length} items in ${branchLabel} as unavailable?\n\nCustomers won't see your menu on WhatsApp until you reopen.`
    : `Bring all ${branchItems.length} items in ${branchLabel} back online?`;
  if (!confirm(label)) return;
  try {
    const body = { available: !isClosing };
    if (branchId) body.branch_id = branchId;
    const r = await api('/api/restaurant/menu/bulk-availability', { method: 'PATCH', body });
    toast(isClosing
      ? `🔴 ${r.updated_count} items marked unavailable — syncing to WhatsApp...`
      : `🟢 ${r.updated_count} items back online — syncing to WhatsApp...`, 'ok');
    loadMenu();
    _updateBulkAvailBtn(!isClosing);
  } catch (e) { toast(e.message, 'err'); }
}
function _updateBulkAvailBtn(allAvailable) {
  const btn = document.getElementById('bulk-avail-btn');
  if (!btn) return;
  if (allAvailable) {
    btn.textContent = '🔴 Close Menu';
    btn.title = 'Mark all items unavailable';
  } else {
    btn.textContent = '🟢 Reopen Menu';
    btn.title = 'Bring all items back online';
  }
}
async function doDeleteItem(id, name) {
  if (!confirm(`Delete "${name}"?`)) return;
  try { await api(`/api/restaurant/menu/${id}`, { method: 'DELETE' }); toast(`"${name}" deleted`, 'ok'); loadMenu(); }
  catch (e) { toast(e.message, 'err'); }
}

function toggleAllMenuItems(checked) {
  document.querySelectorAll('.mi-check').forEach(cb => { cb.checked = checked; });
  updateBulkBar();
}

function updateBulkBar() {
  const checked = document.querySelectorAll('.mi-check:checked');
  const bar = document.getElementById('bulk-bar');
  if (checked.length > 0) {
    bar.style.display = 'flex';
    document.getElementById('bulk-count').textContent = `${checked.length} item${checked.length > 1 ? 's' : ''} selected`;
  } else {
    bar.style.display = 'none';
  }
}

function clearMenuSelection() {
  document.querySelectorAll('.mi-check').forEach(cb => { cb.checked = false; });
  const selectAll = document.querySelector('#menu-list thead input[type="checkbox"]');
  if (selectAll) selectAll.checked = false;
  updateBulkBar();
}

async function doBulkDelete() {
  const checked = document.querySelectorAll('.mi-check:checked');
  const ids = Array.from(checked).map(cb => cb.dataset.id);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} item${ids.length > 1 ? 's' : ''}? This will also remove them from the WhatsApp catalog.`)) return;
  try {
    const r = await api('/api/restaurant/menu/bulk-delete', { method: 'POST', body: { ids } });
    toast(`${r.deleted} items deleted`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  loadMenu();
}

/* ═══════════════════════ SMART CSV MAPPER ════════════════ */
// Robust CSV tokenizer — handles quoted fields, empty cells, CRLF
function splitCSVLine(line) {
  const result = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  result.push(cur.trim());
  return result;
}
// Parse CSV or Excel file — returns same {headers, rows} format
async function parseFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') {
    if (typeof XLSX === 'undefined') throw new Error('Excel parser failed to load. Please refresh the page or try uploading a .csv file instead.');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          if (!data.length || data.length < 2) throw new Error('Need a header row and at least one data row');
          const headers = data[0].map(h => String(h || '').trim()).filter(h => h);
          const colCount = headers.length;
          const rows = data.slice(1)
            .filter(r => r.slice(0, colCount).some(c => String(c).trim() !== ''))
            .map(r => {
              const obj = {};
              headers.forEach((h, i) => { obj[i] = String(r[i] ?? '').trim(); });
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
  // CSV / text
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try { resolve(parseRawCSV(e.target.result)); }
      catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsText(file);
  });
}

function parseRawCSV(text) {
  const lines = text.trim().replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if (lines.length < 2) throw new Error('Need a header row and at least one data row');
  const headers = splitCSVLine(lines[0]);
  const rows = lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[i] = vals[i] ?? ''; });
    return obj;
  });
  return { headers, rows };
}

// Field definitions with aliases for auto-matching
const MENU_FIELDS = [
  { key:'name',        label:'Item Name',          required:true,  aliases:['name','item','item_name','product','dish','food','title','menu_item'] },
  { key:'price',       label:'Price (₹)',           required:true,  aliases:['price','rate','mrp','cost','amount','selling_price','sp','rs','inr'] },
  { key:'category',    label:'Category',            required:false, aliases:['category','cat','section','group','type','menu_section','course'] },
  { key:'description', label:'Description',         required:false, aliases:['description','desc','details','about','info','note','notes'] },
  { key:'food_type',   label:'Food Type (veg/non_veg)', required:false, aliases:['food_type','type','veg_nonveg','veg','nonveg','diet','food_category','is_veg','veg/non-veg'] },
  { key:'image_url',   label:'Image URL',           required:false, aliases:['image_url','image','img','photo','picture','url','photo_url','image_link'] },
  { key:'is_bestseller',label:'Bestseller (true/false)',required:false,aliases:['is_bestseller','bestseller','popular','featured','hot','recommended','best','top'] },
  { key:'size',        label:'Size / Portion',       required:false, aliases:['size','portion','variant','option','variant_value','size_name'] },
  { key:'branch',     label:'Branch / Outlet',       required:false, aliases:['branch','outlet','location','branch_name','outlet_name','store','store_name'] },
];
const OUTLET_FIELDS = [
  { key:'branch_name', label:'Branch / Outlet Name', required:true,  aliases:['branch_name','name','outlet','outlet_name','location','branch','store','store_name','shop'] },
  { key:'address',     label:'Full Address',          required:true,  aliases:['address','addr','full_address','street','street_address','location','full_addr'] },
  { key:'city',        label:'City',                  required:false, aliases:['city','town','district','area','locality'] },
  { key:'latitude',    label:'Latitude',              required:false, aliases:['latitude','lat','y','geo_lat'] },
  { key:'longitude',   label:'Longitude',             required:false, aliases:['longitude','lng','lon','long','x','geo_lng'] },
  { key:'delivery_radius_km', label:'Delivery Radius (km)', required:false, aliases:['delivery_radius_km','radius','delivery_radius','range','km','delivery_km'] },
  { key:'opening_time',label:'Opening Time',          required:false, aliases:['opening_time','open_time','opens','from','start','start_time','open'] },
  { key:'closing_time',label:'Closing Time',          required:false, aliases:['closing_time','close_time','closes','to','end','end_time','close'] },
  { key:'manager_phone',label:'Manager Phone',        required:false, aliases:['manager_phone','phone','contact','mobile','manager','manager_mobile','contact_no'] },
];

function autoMatch(headerRaw, fields) {
  const h = headerRaw.toLowerCase().trim().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
  for (const f of fields) {
    if (f.aliases.includes(h)) return f.key;
  }
  // partial match
  for (const f of fields) {
    if (f.aliases.some(a => h.includes(a) || a.includes(h))) return f.key;
  }
  return '__skip__';
}

function renderMapper(containerId, headers, fields, onConfirm) {
  const container = document.getElementById(containerId);
  const skipOpt = '<option value="__skip__">(skip this column)</option>';
  const fieldOpts = fields.map(f =>
    `<option value="${f.key}">${f.label}${f.required?' ★':''}</option>`
  ).join('');

  const rows = headers.map((h, i) => {
    const matched = autoMatch(h, fields);
    const selClass = matched === '__skip__' ? '' : 'mapped';
    return `<div class="cm-your">${h || '(empty)'}</div>
    <div class="cm-arrow">→</div>
    <select id="cm-sel-${containerId}-${i}" class="${selClass}" onchange="updateMapperSel(this)">
      ${skipOpt}${fieldOpts}
    </select>`;
  }).join('');

  container.style.display = 'block';
  container.innerHTML = `
    <div class="csv-mapper">
      <h4>🗂️ Map your columns — we auto-detected the best match, adjust if needed</h4>
      <div class="csv-mapper-grid">${rows}</div>
      <div style="display:flex;gap:.6rem;margin-top:.9rem;align-items:center">
        <button class="btn-p btn-sm" onclick="confirmMapper('${containerId}')">✅ Confirm Mapping & Preview</button>
        <span style="font-size:.76rem;color:var(--dim)">★ = required field</span>
      </div>
      <div id="${containerId}-err" style="margin-top:.5rem;font-size:.78rem;color:var(--red)"></div>
    </div>`;

  // Set auto-matched values after render
  headers.forEach((h, i) => {
    const sel = document.getElementById(`cm-sel-${containerId}-${i}`);
    if (sel) { sel.value = autoMatch(h, fields); updateMapperSel(sel); }
  });

  // Store refs
  container._headers = headers;
  container._fields  = fields;
  container._onConfirm = onConfirm;

  // Auto-skip mapping if all required fields matched
  const autoMapping = {};
  headers.forEach((h, i) => {
    const m = autoMatch(h, fields);
    if (m !== '__skip__' && !(m in autoMapping)) autoMapping[m] = i;
  });
  const allRequiredMapped = fields.filter(f => f.required).every(f => f.key in autoMapping);
  if (allRequiredMapped && Object.keys(autoMapping).length >= 2) {
    // Auto-confirm — skip the mapping UI
    console.log('[CSV] Auto-matched all required fields, skipping mapping UI');
    container.style.display = 'none';
    onConfirm(autoMapping);
  }
}

function updateMapperSel(sel) {
  sel.className = sel.value === '__skip__' ? '' : 'mapped';
  const f = (sel._fields || []).find(f => f.key === sel.value);
  if (f?.required) sel.className = 'mapped';
}

function confirmMapper(containerId) {
  const container = document.getElementById(containerId);
  const headers = container._headers;
  const fields  = container._fields;
  const mapping = {}; // fieldKey → colIndex
  let missingRequired = [];

  headers.forEach((h, i) => {
    const sel = document.getElementById(`cm-sel-${containerId}-${i}`);
    if (sel && sel.value !== '__skip__') {
      if (!(sel.value in mapping)) mapping[sel.value] = i; // first wins
    }
  });

  fields.filter(f => f.required).forEach(f => {
    if (!(f.key in mapping)) missingRequired.push(f.label);
  });

  const errEl = document.getElementById(`${containerId}-err`);
  if (missingRequired.length) {
    errEl.textContent = `Please map required fields: ${missingRequired.join(', ')}`;
    return;
  }
  errEl.textContent = '';
  container._onConfirm(mapping);
}

function applyMapping(rawRows, mapping) {
  return rawRows.map(row => {
    const out = {};
    for (const [key, idx] of Object.entries(mapping)) { out[key] = row[idx] ?? ''; }
    return out;
  });
}


let csvParsed = [], _csvRaw = null;

function handleCsvFile(input) {
  const file = input.files[0]; if (!file) return;
  processCsvFile(file);
}
function handleCsvDrop(e) {
  const file = e.dataTransfer.files[0]; if (!file) return;
  processCsvFile(file);
}
let _csvMultiBranch = false; // true if branch column detected in uploaded file

async function processCsvFile(file) {
  try {
    _csvRaw = await parseFile(file);
    _csvMultiBranch = false;
    document.getElementById('csv-preview').style.display  = 'none';
    document.getElementById('csv-result').style.display   = 'none';

    // Detect branch column in headers
    const BRANCH_ALIASES = ['branch', 'outlet', 'location', 'branch_name', 'outlet_name', 'store', 'store_name'];
    const hasBranchCol = _csvRaw.headers.some(h => BRANCH_ALIASES.includes((h||'').toLowerCase().trim()));

    if (hasBranchCol) {
      _csvMultiBranch = true;
    } else {
      const branchId = document.getElementById('m-branch').value;
      if (!branchId) return toast('Select a branch first, or include a "branch" column in your file for multi-branch upload', 'err');
    }

    renderMapper('csv-mapper-menu', _csvRaw.headers, MENU_FIELDS, mapping => {
      csvParsed = applyMapping(_csvRaw.rows, mapping);
      const missing = csvParsed.filter(r => !r.name || !r.price);
      let countText = `${csvParsed.length} items from "${file.name}"`;
      if (_csvMultiBranch) countText += ' · 🏪 Branch column detected — items will be routed automatically';
      if (missing.length) countText += ` · ⚠️ ${missing.length} rows missing name/price will be skipped`;
      document.getElementById('csv-count').textContent = countText;
      // Update thead to include branch column when multi-branch
      var headEl = document.getElementById('csv-preview-head');
      if (headEl) {
        headEl.innerHTML = _csvMultiBranch
          ? '<tr><th>#</th><th>\uD83C\uDFEA</th><th>Name</th><th>Category</th><th>Price</th><th>Type</th><th>\u2B50</th></tr>'
          : '<tr><th>#</th><th>Name</th><th>Category</th><th>Price</th><th>Type</th><th>\u2B50</th></tr>';
      }
      var colSpan = _csvMultiBranch ? 7 : 6;
      document.getElementById('csv-preview-body').innerHTML =
        csvParsed.slice(0,8).map(function(r,i) {
          var branchCell = _csvMultiBranch ? '<td style="font-size:.75rem;color:var(--wa)">' + (r.branch || r.outlet || r.location || '\u2014') + '</td>' : '';
          return '<tr>'
            + '<td style="color:var(--dim)">' + (i+1) + '</td>'
            + branchCell
            + '<td>' + (r.name || '<span style="color:var(--red)">missing</span>') + '</td>'
            + '<td>' + (r.category || '\u2014') + '</td>'
            + '<td>' + (r.price ? '\u20B9' + r.price : '<span style="color:var(--red)">missing</span>') + '</td>'
            + '<td>' + (r.food_type || 'veg') + '</td>'
            + '<td>' + (['true','yes','1'].includes((r.is_bestseller||'').toLowerCase()) ? '\u2B50' : '') + '</td>'
            + '</tr>';
        }).join('') +
        (csvParsed.length > 8 ? '<tr><td colspan="' + colSpan + '" style="text-align:center;color:var(--dim);font-size:.75rem">+ ' + (csvParsed.length - 8) + ' more rows\u2026</td></tr>' : '');
      document.getElementById('csv-preview').style.display = 'block';
    });
  } catch (e) { toast('Could not parse CSV: ' + e.message, 'err'); }
}
function resetCsv() {
  csvParsed = []; _csvRaw = null;
  document.getElementById('csv-file').value    = '';
  document.getElementById('csv-mapper-menu').style.display = 'none';
  document.getElementById('csv-preview').style.display = 'none';
  document.getElementById('csv-result').style.display  = 'none';
}
async function doUploadCsv() {
  const branchId = document.getElementById('m-branch').value;
  if (!_csvMultiBranch && !branchId) return toast('Select a branch first', 'err');
  if (!csvParsed.length) return toast('No CSV data to upload', 'err');
  const btn = document.getElementById('csv-upload-btn');
  const el  = document.getElementById('csv-result');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Uploading…';
  try {
    let r;
    if (_csvMultiBranch) {
      // Multi-branch: use restaurant-level endpoint
      r = await api('/api/restaurant/menu/csv', { method: 'POST', body: { items: csvParsed, branchId } });
    } else {
      // Single-branch: use branch-specific endpoint
      r = await api(`/api/restaurant/branches/${branchId}/menu/csv`, { method: 'POST', body: { items: csvParsed } });
    }

    el.style.display = 'block';

    // Build result HTML
    let resultHtml = `<div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center">
      <span class="csv-result-ok">✅ <strong>${r.added}</strong> items added/updated</span>
      ${r.skipped ? `<span class="csv-result-warn">⚠️ <strong>${r.skipped}</strong> rows skipped</span>` : ''}
      <span id="csv-sync-status" style="font-size:.8rem;color:var(--dim);margin-left:.4rem">🔄 Syncing to WhatsApp catalog…</span>
    </div>`;

    // Multi-branch: show per-branch breakdown
    if (r.per_branch && r.per_branch.length > 1) {
      resultHtml += `<div style="margin-top:.6rem;font-size:.8rem">
        <strong>Per-branch breakdown:</strong>
        ${r.per_branch.map(pb => `<div style="margin-top:.2rem">🏪 <strong>${pb.branchName}</strong>: ${pb.added} added${pb.skipped ? `, ${pb.skipped} skipped` : ''}</div>`).join('')}
        ${r.unmatched_branches?.length ? `<div style="margin-top:.4rem;color:var(--red)">⚠️ Unmatched branches (items went to default): ${r.unmatched_branches.join(', ')}</div>` : ''}
      </div>`;
    }

    if (r.errors?.length) {
      resultHtml += `<div style="margin-top:.5rem;font-size:.75rem;color:var(--red)">${r.errors.slice(0, 5).join('<br>')}</div>`;
    }

    // Stale items notification
    if (r.stale_items?.total > 0) {
      resultHtml += `<div style="margin-top:.6rem;padding:.5rem .7rem;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:.8rem;color:#92400e">
        \u26A0\uFE0F <strong>${r.stale_items.total} item${r.stale_items.total > 1 ? 's' : ''}</strong> not in your upload ${r.stale_items.total > 1 ? 'were' : 'was'} marked unavailable:
        ${r.stale_items.per_branch.map(function(b) { return '<div style="margin-top:.2rem;font-size:.75rem">\uD83C\uDFEA ' + b.branchName + ': ' + b.items.map(function(it) { return it.name; }).join(', ') + (b.more > 0 ? ' and ' + b.more + ' more' : '') + '</div>'; }).join('')}
      </div>`;
    }
    if (r.stale_items?.warnings?.length) {
      resultHtml += r.stale_items.warnings.map(function(w) { return '<div style="margin-top:.4rem;font-size:.75rem;color:var(--dim)">\u2139\uFE0F ' + w + '</div>'; }).join('');
    }

    el.innerHTML = resultHtml;
    resetCsv();
    loadMenu();

    // If multi-branch upload, refresh branch list (new branches may have been auto-created)
    if (_csvMultiBranch) {
      try {
        var brData = await api('/api/restaurant/branches');
        if (brData) { branches = brData; loadBranchSel(); }
      } catch (_) {}
    }

    // Auto-sync catalog
    const syncEl = document.getElementById('csv-sync-status');
    try {
      const s = await api('/api/restaurant/catalog/sync', { method: 'POST' });
      const totalSynced = s.totalSynced || 0;
      const totalFailed = s.totalFailed || 0;
      if (syncEl) {
        if (totalFailed > 0) {
          syncEl.innerHTML = `<span style="color:#d97706">⚠️ ${totalSynced} synced, ${totalFailed} failed</span> <button class="btn-g btn-sm" onclick="doSyncToCatalog()" style="font-size:.7rem;padding:.15rem .4rem;margin-left:.3rem">Retry Sync</button>`;
          toast(`Menu saved but ${totalFailed} items failed to sync to WhatsApp`, 'err');
        } else {
          syncEl.innerHTML = `<span style="color:var(--wa)">✅ ${totalSynced} items live on WhatsApp!</span>`;
        }
      }
    } catch (se) {
      if (syncEl) syncEl.innerHTML = `<span style="color:var(--red)">⚠️ Sync failed: ${se.message}</span> <button class="btn-g btn-sm" onclick="doSyncToCatalog()" style="font-size:.7rem;padding:.15rem .4rem;margin-left:.3rem">Retry Sync</button>`;
      toast('Menu saved but WhatsApp sync failed: ' + se.message, 'err');
    }

    toast(`✅ ${r.added} items uploaded!`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '⬆ Upload & Sync'; }
}
function doDownloadSample() {
  var sample = [
    'name,price,category,branch,food_type,size,description,is_bestseller,image_url',
    'Chicken Biryani,320,Biryani,Koramangala,non_veg,Full,Aromatic dum biryani with tender chicken,yes,',
    'Chicken Biryani,180,Biryani,Koramangala,non_veg,Half,Aromatic dum biryani with tender chicken,,',
    'Paneer Tikka,280,Starters,Koramangala,veg,,Grilled cottage cheese marinated in spices,yes,',
    'Butter Naan,45,Breads,Koramangala,veg,,Soft and buttery tandoor naan,,',
    'Masala Chai,40,Beverages,Koramangala,veg,,Fresh brewed spiced tea,,',
    'Chicken Biryani,350,Biryani,Indiranagar,non_veg,Full,Aromatic dum biryani with tender chicken,yes,',
    'Chicken Biryani,200,Biryani,Indiranagar,non_veg,Half,Aromatic dum biryani with tender chicken,,',
    'Paneer Tikka,300,Starters,Indiranagar,veg,,Grilled cottage cheese marinated in spices,,',
  ].join('\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([sample], { type: 'text/csv' }));
  a.download = 'gullybite-menu-sample.csv';
  a.click();
}


async function doSyncSets() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId) return toast('Select a branch first', 'err');
  const btn = document.getElementById('m-sets-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Syncing…';
  try {
    const r = await api(`/api/restaurant/branches/${branchId}/sync-sets`, { method: 'POST' });
    if (r.skipped) toast('No categories with items to sync', 'nfo');
    else toast(`Product sets synced — ${r.created} created, ${r.updated} updated`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '📂 Sync Product Sets'; }
}

/* ──────────────────── PRODUCT SETS ──────────────────────── */
let _editingSetId = null;

async function loadProductSets() {
  const branchId = document.getElementById('m-branch').value;
  const card = document.getElementById('product-sets-card');
  if (!branchId) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const area = document.getElementById('product-sets-list');
  try {
    const sets = await api(`/api/restaurant/product-sets?branch_id=${branchId}`);
    if (!sets?.length) {
      area.innerHTML = `<p style="color:var(--dim);font-size:.82rem">No product sets yet. Click <b>Auto-Create</b> to generate from your menu categories, or <b>Create Set</b> to add manually.</p>`;
      return;
    }
    area.innerHTML = `<div style="display:flex;flex-direction:column;gap:.4rem">${sets.map(s => {
      const syncBadge = s.meta_product_set_id
        ? `<span style="font-size:.65rem;color:var(--wa)">🟢 synced</span>`
        : `<span style="font-size:.65rem;color:var(--gold)">🟡 pending</span>`;
      const typeBadge = `<span class="badge bd" style="font-size:.62rem">${s.type}</span>`;
      const safeName = s.name.replace(/'/g, "\\'");
      return `<div style="display:flex;align-items:center;gap:.6rem;padding:.5rem .7rem;background:var(--ink);border-radius:8px">
        <span style="font-weight:600;font-size:.84rem;flex:1">${s.name}</span>
        ${typeBadge} ${syncBadge}
        <button class="btn-g btn-sm" style="font-size:.72rem" onclick="openEditSetModal('${s.id}','${safeName}','${s.type}','${(s.filter_value||'').replace(/'/g,"\\'")}','${(s.manual_retailer_ids||[]).join(',')}',${s.sort_order||0})">✏ Edit</button>
        <button class="btn-del btn-sm" style="font-size:.72rem" onclick="doDeleteSet('${s.id}','${safeName}')">🗑</button>
      </div>`;
    }).join('')}</div>`;
  } catch (e) { area.innerHTML = `<p style="color:var(--red);font-size:.82rem">${e.message}</p>`; }
}

function onSetTypeChange() {
  const t = document.getElementById('set-type').value;
  document.getElementById('set-filter-row').style.display = t !== 'manual' ? '' : 'none';
  document.getElementById('set-manual-row').style.display = t === 'manual' ? '' : 'none';
}

function openCreateSetModal() {
  _editingSetId = null;
  document.getElementById('set-modal-title').textContent = 'Create Product Set';
  document.getElementById('set-save-btn').textContent = 'Create';
  ['set-name', 'set-filter', 'set-manual-ids'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('set-sort').value = '0';
  document.getElementById('set-type').value = 'category';
  onSetTypeChange();
  document.getElementById('set-modal').style.display = 'flex';
}

function openEditSetModal(id, name, type, filterVal, manualIds, sortOrder) {
  _editingSetId = id;
  document.getElementById('set-modal-title').textContent = 'Edit Product Set';
  document.getElementById('set-save-btn').textContent = 'Save';
  document.getElementById('set-name').value = name;
  document.getElementById('set-type').value = type;
  document.getElementById('set-filter').value = filterVal;
  document.getElementById('set-manual-ids').value = manualIds;
  document.getElementById('set-sort').value = sortOrder;
  onSetTypeChange();
  document.getElementById('set-modal').style.display = 'flex';
}

function closeSetModal() {
  document.getElementById('set-modal').style.display = 'none';
  _editingSetId = null;
}

async function doSaveSet() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId) return toast('Select a branch first', 'err');
  const name = document.getElementById('set-name').value.trim();
  if (!name) return toast('Set name required', 'err');
  const type = document.getElementById('set-type').value;
  const body = {
    branchId, name, type,
    filterValue: document.getElementById('set-filter').value.trim() || null,
    manualRetailerIds: type === 'manual' ? document.getElementById('set-manual-ids').value.split(',').map(s => s.trim()).filter(Boolean) : [],
    sortOrder: parseInt(document.getElementById('set-sort').value) || 0,
  };
  try {
    if (_editingSetId) {
      await api(`/api/restaurant/product-sets/${_editingSetId}`, { method: 'PUT', body });
      toast(`Set "${name}" updated`, 'ok');
    } else {
      await api('/api/restaurant/product-sets', { method: 'POST', body });
      toast(`Set "${name}" created`, 'ok');
    }
    closeSetModal();
    loadProductSets();
  } catch (e) { toast(e.message, 'err'); }
}

async function doDeleteSet(id, name) {
  if (!confirm(`Delete product set "${name}"?`)) return;
  try {
    await api(`/api/restaurant/product-sets/${id}`, { method: 'DELETE' });
    toast(`Set "${name}" deleted`, 'ok');
    loadProductSets();
  } catch (e) { toast(e.message, 'err'); }
}

async function doAutoCreateSets() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId) return toast('Select a branch first', 'err');
  try {
    const r = await api('/api/restaurant/product-sets/auto-create', { method: 'POST', body: { branchId } });
    toast(`Auto-created ${r.created} sets (${r.skipped} skipped)`, 'ok');
    loadProductSets();
  } catch (e) { toast(e.message, 'err'); }
}

async function doSyncAllSets() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId) return toast('Select a branch first', 'err');
  try {
    const r = await api('/api/restaurant/product-sets/sync', { method: 'POST', body: { branchId } });
    if (r.skipped) toast('No sets to sync', 'nfo');
    else toast(`Synced — ${r.created} created, ${r.updated} updated on Meta`, 'ok');
    loadProductSets();
  } catch (e) { toast(e.message, 'err'); }
}


let _editingCollId = null;
let _collProductSets = []; // cached sets for the picker

async function loadCollections() {
  const branchId = document.getElementById('m-branch').value;
  const card = document.getElementById('collections-card');
  if (!branchId) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const area = document.getElementById('collections-list');
  try {
    const colls = await api(`/api/restaurant/collections?branch_id=${branchId}`);
    if (!colls?.length) {
      area.innerHTML = `<p style="color:var(--dim);font-size:.82rem">No collections yet. Click <b>Auto-Create</b> to generate from product sets, or <b>Create</b> to add manually.</p>`;
      return;
    }
    area.innerHTML = `<div style="display:flex;flex-direction:column;gap:.4rem">${colls.map((c, idx) => {
      const syncBadge = c.synced
        ? '<span style="font-size:.65rem;color:var(--wa)">🟢 synced</span>'
        : '<span style="font-size:.65rem;color:var(--gold)">🟡 pending</span>';
      const activeBadge = c.is_active === false
        ? '<span style="font-size:.65rem;color:var(--mute)">⚪ inactive</span>' : '';
      const setCount = c.product_sets?.length || 0;
      const setNames = c.product_sets?.map(s => s.name).join(', ') || '—';
      const safeName = esc(c.name);
      return `<div style="display:flex;align-items:center;gap:.6rem;padding:.55rem .7rem;background:var(--ink);border-radius:8px" draggable="true" data-coll-id="${c.id}" data-coll-idx="${idx}">
        <span style="cursor:grab;color:var(--mute);font-size:1rem" title="Drag to reorder">⠿</span>
        <div style="flex:1">
          <div style="font-weight:600;font-size:.84rem">${safeName}</div>
          <div style="font-size:.7rem;color:var(--dim)">${setCount} set${setCount !== 1 ? 's' : ''}: ${esc(setNames)}</div>
        </div>
        ${activeBadge} ${syncBadge}
        <button class="btn-g btn-sm" style="font-size:.72rem" onclick="openEditCollModal('${c.id}')">✏ Edit</button>
        <button class="btn-del btn-sm" style="font-size:.72rem" onclick="doDeleteColl('${c.id}','${safeName.replace(/'/g,"\\'")}')">🗑</button>
      </div>`;
    }).join('')}</div>`;

    // Simple drag-and-drop reorder
    setupCollDragDrop(colls);
  } catch (e) { area.innerHTML = `<p style="color:var(--red);font-size:.82rem">${e.message}</p>`; }
}

function setupCollDragDrop(colls) {
  const items = document.querySelectorAll('[data-coll-id]');
  let dragSrc = null;
  items.forEach(item => {
    item.addEventListener('dragstart', (e) => { dragSrc = item; item.style.opacity = '.4'; });
    item.addEventListener('dragend', () => { item.style.opacity = '1'; });
    item.addEventListener('dragover', (e) => e.preventDefault());
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (dragSrc === item) return;
      const fromIdx = parseInt(dragSrc.dataset.collIdx);
      const toIdx = parseInt(item.dataset.collIdx);
      // Build new order
      const reordered = [...colls];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      const orderItems = reordered.map((c, i) => ({ id: c.id, sort_order: i }));
      try {
        await api('/api/restaurant/collections/reorder', { method: 'PUT', body: { items: orderItems } });
        toast('Order updated', 'ok');
        loadCollections();
      } catch (err) { toast(err.message, 'err'); }
    });
  });
}

async function openCreateCollModal() {
  _editingCollId = null;
  document.getElementById('coll-modal-title').textContent = 'Create Collection';
  document.getElementById('coll-save-btn').textContent = 'Create';
  ['coll-name', 'coll-desc', 'coll-cover'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('coll-sort').value = '0';
  await loadCollSetsPicker([]);
  document.getElementById('coll-modal').style.display = 'flex';
}

async function openEditCollModal(collId) {
  const branchId = document.getElementById('m-branch').value;
  const colls = await api(`/api/restaurant/collections?branch_id=${branchId}`);
  const coll = colls?.find(c => c.id === collId);
  if (!coll) return toast('Collection not found', 'err');

  _editingCollId = collId;
  document.getElementById('coll-modal-title').textContent = 'Edit Collection';
  document.getElementById('coll-save-btn').textContent = 'Save';
  document.getElementById('coll-name').value = coll.name;
  document.getElementById('coll-desc').value = coll.description || '';
  document.getElementById('coll-sort').value = coll.sort_order || 0;
  document.getElementById('coll-cover').value = coll.cover_image_url || '';

  const selectedIds = (coll.product_set_ids || []);
  await loadCollSetsPicker(selectedIds);
  document.getElementById('coll-modal').style.display = 'flex';
}

async function loadCollSetsPicker(selectedIds) {
  const branchId = document.getElementById('m-branch').value;
  const picker = document.getElementById('coll-sets-picker');
  try {
    _collProductSets = await api(`/api/restaurant/product-sets?branch_id=${branchId}`);
    if (!_collProductSets?.length) {
      picker.innerHTML = '<p style="font-size:.78rem;color:var(--dim)">No product sets. Create product sets first.</p>';
      return;
    }
    picker.innerHTML = _collProductSets.map(s => {
      const checked = selectedIds.includes(s.id) ? 'checked' : '';
      return `<label style="display:flex;align-items:center;gap:.4rem;padding:.25rem 0;font-size:.82rem;cursor:pointer">
        <input type="checkbox" class="coll-set-cb" value="${s.id}" ${checked}>
        ${esc(s.name)} <span style="font-size:.65rem;color:var(--dim)">(${s.type})</span>
      </label>`;
    }).join('');
  } catch { picker.innerHTML = '<p style="font-size:.78rem;color:var(--red)">Failed to load sets</p>'; }
}

function closeCollModal() {
  document.getElementById('coll-modal').style.display = 'none';
  _editingCollId = null;
}

async function doSaveColl() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId) return toast('Select a branch first', 'err');
  const name = document.getElementById('coll-name').value.trim();
  if (!name) return toast('Collection name required', 'err');

  const selectedSets = [...document.querySelectorAll('.coll-set-cb:checked')].map(cb => cb.value);

  const body = {
    branchId, name,
    description: document.getElementById('coll-desc').value.trim() || null,
    productSetIds: selectedSets,
    coverImageUrl: document.getElementById('coll-cover').value.trim() || null,
    sortOrder: parseInt(document.getElementById('coll-sort').value) || 0,
  };

  try {
    if (_editingCollId) {
      await api(`/api/restaurant/collections/${_editingCollId}`, { method: 'PUT', body });
      toast(`Collection "${name}" updated`, 'ok');
    } else {
      await api('/api/restaurant/collections', { method: 'POST', body });
      toast(`Collection "${name}" created`, 'ok');
    }
    closeCollModal();
    loadCollections();
  } catch (e) { toast(e.message, 'err'); }
}

async function doDeleteColl(id, name) {
  if (!confirm(`Delete collection "${name}"? It will also be removed from WhatsApp.`)) return;
  try {
    await api(`/api/restaurant/collections/${id}`, { method: 'DELETE' });
    toast(`Collection "${name}" deleted`, 'ok');
    loadCollections();
  } catch (e) { toast(e.message, 'err'); }
}

async function doAutoCreateCollections() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId) return toast('Select a branch first', 'err');
  try {
    const r = await api('/api/restaurant/collections/auto-create', { method: 'POST', body: { branchId } });
    toast(`Auto-created ${r.created} collections (${r.skipped} skipped)`, 'ok');
    loadCollections();
  } catch (e) { toast(e.message, 'err'); }
}

async function doSyncAllCollections() {
  const branchId = document.getElementById('m-branch').value;
  if (!branchId) return toast('Select a branch first', 'err');
  try {
    const r = await api('/api/restaurant/collections/sync', { method: 'POST', body: { branchId } });
    if (r.skipped) toast('No collections to sync', 'nfo');
    else toast(`Synced — ${r.created} created, ${r.updated} updated on Meta`, 'ok');
    loadCollections();
  } catch (e) { toast(e.message, 'err'); }
}


let varItemId   = null;
let varItemName = '';

function openVarModal(itemId, itemName, existingGroupId) {
  varItemId   = itemId;
  varItemName = itemName;
  document.getElementById('var-modal-title').textContent = `Add Variant to "${itemName}"`;
  document.getElementById('var-label').value      = '';
  document.getElementById('var-price').value      = '';
  document.getElementById('var-type').value       = 'size';
  document.getElementById('var-base-label').value = 'Regular';
  // If already in a group, hide the "original becomes" row
  const baseRow = document.getElementById('var-base-label').closest('.fg');
  if (baseRow) baseRow.style.display = existingGroupId ? 'none' : '';
  document.getElementById('var-modal').classList.add('on');
}

function closeVarModal() {
  document.getElementById('var-modal').classList.remove('on');
  varItemId = null;
}

async function doAddVariant() {
  if (!varItemId) return;
  const variantLabel = document.getElementById('var-label').value.trim();
  const priceRs      = document.getElementById('var-price').value;
  const variantType  = document.getElementById('var-type').value;
  const baseLabel    = document.getElementById('var-base-label').value.trim() || 'Regular';
  if (!variantLabel || !priceRs) return toast('Label and price are required', 'err');

  const btn = document.getElementById('var-save-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Adding…';
  try {
    await api(`/api/restaurant/menu/${varItemId}/variants`, {
      method: 'POST',
      body  : { variantLabel, variantType, priceRs: parseFloat(priceRs), baseLabel },
    });
    toast(`"${variantLabel}" variant added! Syncing to WhatsApp…`, 'ok');
    closeVarModal();
    loadMenu();
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '+ Add Variant'; }
}


function syncImgPreview(url) {
  const img  = document.getElementById('img-preview-img');
  const icon = document.getElementById('img-preview-icon');
  if (url && url.startsWith('http')) {
    img.src = url;
    img.style.display = 'block';
    icon.style.display = 'none';
    img.onerror = () => { img.style.display = 'none'; icon.style.display = ''; icon.textContent = '📷'; updateImgQuality(false); };
    updateImgQuality(true);
  } else {
    img.style.display = 'none';
    icon.style.display = '';
    icon.textContent = '📷';
    updateImgQuality(false);
  }
}

async function handleImgFile(input) {
  const file = input.files[0];
  if (!file) return;

  const spin  = document.getElementById('img-preview-spin');
  const img   = document.getElementById('img-preview-img');
  const icon  = document.getElementById('img-preview-icon');
  const urlIn = document.getElementById('m-img');

  // Show local preview immediately while uploading
  const localUrl = URL.createObjectURL(file);
  img.src = localUrl;
  img.style.display = 'block';
  icon.style.display = 'none';
  spin.style.display = 'flex';

  try {
    const branchId = document.getElementById('m-branch').value;
    if (!branchId) {
      spin.style.display = 'none';
      return toast('Select a branch before uploading an image', 'err');
    }

    const form = new FormData();
    form.append('image', file);

    const res = await fetch('/api/restaurant/menu/upload-image', {
      method : 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body   : form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    urlIn.value = data.url;
    _lastUploadedThumb = data.thumbnail_url || null;
    _lastUploadedS3Key = data.s3_key || null;
    toast('Image uploaded!', 'ok');
    updateImgQuality(true);
  } catch (e) {
    toast(e.message, 'err');
    // Revert preview on failure
    img.style.display = 'none';
    icon.style.display = '';
    icon.textContent = '📷';
    urlIn.value = '';
    updateImgQuality(false);
  } finally {
    spin.style.display = 'none';
    input.value = '';            // reset file input so same file can be re-selected
  }
}

function resetImgPicker() {
  const img  = document.getElementById('img-preview-img');
  const icon = document.getElementById('img-preview-icon');
  img.src = '';
  img.style.display = 'none';
  icon.style.display = '';
  icon.textContent = '📷';
  document.getElementById('m-img').value = '';
  _lastUploadedThumb = null;
  _lastUploadedS3Key = null;
  updateImgQuality(false);
}

function updateImgQuality(hasImage) {
  const el = document.getElementById('img-quality-indicator');
  if (!el) return;
  if (hasImage) {
    el.style.color = 'var(--wa)';
    el.textContent = 'Meets Meta catalog requirements';
  } else {
    el.style.color = 'var(--red)';
    el.textContent = 'Add a photo (min 500x500px) for WhatsApp catalog';
  }
}


async function loadImageStats() {
  const bar = document.getElementById('img-stats-bar');
  if (!bar) return;
  try {
    const stats = await api('/api/restaurant/images/stats');
    if (stats && typeof stats.withImages === 'number') {
      const pct = stats.totalItems ? Math.round((stats.withImages / stats.totalItems) * 100) : 0;
      bar.textContent = `📷 ${stats.withImages} of ${stats.totalItems} items have photos (${pct}%)`;
      bar.style.display = 'block';
    } else {
      bar.style.display = 'none';
    }
  } catch (_) {
    bar.style.display = 'none';
  }
}

function openBulkImageUpload() {
  document.getElementById('bulk-img-modal').style.display = 'flex';
  document.getElementById('bulk-img-files').value = '';
  document.getElementById('bulk-img-list').innerHTML = '';
  document.getElementById('bulk-img-results').innerHTML = '';
  document.getElementById('bulk-img-results').style.display = 'none';
}
function closeBulkImageUpload() {
  document.getElementById('bulk-img-modal').style.display = 'none';
}

function updateBulkFileList() {
  const input = document.getElementById('bulk-img-files');
  const list = document.getElementById('bulk-img-list');
  const files = input.files;
  if (!files.length) { list.innerHTML = ''; return; }
  list.innerHTML = [...files].map((f, i) => `<div style="font-size:.8rem;padding:.25rem 0;color:var(--tx)">${i + 1}. ${f.name} <span style="color:var(--dim)">(${(f.size / 1024).toFixed(0)} KB)</span></div>`).join('');
}

async function doBulkImageUpload() {
  const input = document.getElementById('bulk-img-files');
  const files = input.files;
  if (!files.length) return toast('Select at least one image', 'err');
  if (files.length > 20) return toast('Maximum 20 files at a time', 'err');

  const btn = document.getElementById('bulk-img-go');
  btn.disabled = true;
  btn.innerHTML = '<div class="spin" style="width:16px;height:16px"></div> Uploading...';

  try {
    const form = new FormData();
    for (const f of files) form.append('images', f);

    const res = await fetch('/api/restaurant/images/bulk-upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Bulk upload failed');

    const results = document.getElementById('bulk-img-results');
    results.style.display = 'block';
    let html = '';
    if (data.matched?.length) {
      html += `<div style="margin-bottom:.5rem"><strong style="color:var(--wa);font-size:.82rem">Matched ${data.matched.length} item(s):</strong></div>`;
      html += data.matched.map(m => `<div style="font-size:.8rem;padding:.15rem 0">✅ ${m.fileName} → ${m.itemName}</div>`).join('');
    }
    if (data.unmatched?.length) {
      html += `<div style="margin-top:.5rem;margin-bottom:.3rem"><strong style="color:var(--gold);font-size:.82rem">${data.unmatched.length} unmatched image(s):</strong></div>`;
      html += data.unmatched.map(u => `<div style="font-size:.8rem;padding:.15rem 0;color:var(--dim)">⚠️ ${u.fileName}</div>`).join('');
    }
    if (!data.matched?.length && !data.unmatched?.length) {
      html = `<div style="font-size:.82rem;color:var(--dim)">Upload complete. ${data.uploaded || 0} image(s) processed.</div>`;
    }
    results.innerHTML = html;
    toast(`Bulk upload complete!`, 'ok');
    loadMenu();
    loadImageStats();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload All';
  }
}


// Expose to window
window.addrSearch = addrSearch;
window._addrHover = _addrHover;
window._addrHighlightUpdate = _addrHighlightUpdate;
window._addrKeydown = _addrKeydown;
window.addrPick = addrPick;
window._setAddrIcon = _setAddrIcon;
// _esc is in shared.js
window.handleOutletCsvFile = handleOutletCsvFile;
window.handleOutletCsvDrop = handleOutletCsvDrop;
window.processOutletFile = processOutletFile;
window.resetOutletCsv = resetOutletCsv;
window.geocodeAddress = geocodeAddress;
window.doUploadOutletCsv = doUploadOutletCsv;
window.doDownloadOutletSample = doDownloadOutletSample;
window.doAddBranch = doAddBranch;
window.loadBranches = loadBranches;
window._formatHoursSummary = _formatHoursSummary;
window.renderBranchCard = renderBranchCard;
window.doCreateCatalog = doCreateCatalog;
window.doSync = doSync;
window.animBar = animBar;
window.doToggle = doToggle;
// FUTURE FEATURE: hours editor functions moved to restaurant.js
window.editBranchAddr = editBranchAddr;
window._editAddrSearch = _editAddrSearch;
window._editAddrKeydown = _editAddrKeydown;
window._editAddrPick = _editAddrPick;
window.saveBranchAddr = saveBranchAddr;
window.toggleAddDropdown = toggleAddDropdown;
window.toggleMenuSection = toggleMenuSection;
window.loadCatalogPanelContent = loadCatalogPanelContent;
window.loadBranchSel = loadBranchSel;
window.selectBranchTab = selectBranchTab;
window.doSelectBranch = doSelectBranch;
window.loadMenu = loadMenu;
window.renderMenuGroups = renderMenuGroups;
window.toggleCatManager = toggleCatManager;
window.renderCatList = renderCatList;
window.doCreateCat = doCreateCat;
window.startEditCat = startEditCat;
window.cancelEditCat = cancelEditCat;
window.saveCat = saveCat;
window.doDeleteCat = doDeleteCat;
window.onCatChange = onCatChange;
window.onVariantToggle = onVariantToggle;
window.addVariantRow = addVariantRow;
window.doAddItem = doAddItem;
window.doQuickSync = doQuickSync;
window.doSyncToCatalog = doSyncToCatalog;
window.doSyncFromCatalog = doSyncFromCatalog;
window.updateSyncStatus = updateSyncStatus;
window.timeAgoShort = timeAgoShort;
window.doFixCatalog = doFixCatalog;
window.doToggleItem = doToggleItem;
window.doBulkAvailability = doBulkAvailability;
window._updateBulkAvailBtn = _updateBulkAvailBtn;
window.doDeleteItem = doDeleteItem;
window.toggleAllMenuItems = toggleAllMenuItems;
window.updateBulkBar = updateBulkBar;
window.clearMenuSelection = clearMenuSelection;
window.doBulkDelete = doBulkDelete;
window.splitCSVLine = splitCSVLine;
window.parseFile = parseFile;
window.parseRawCSV = parseRawCSV;
window.autoMatch = autoMatch;
window.renderMapper = renderMapper;
window.updateMapperSel = updateMapperSel;
window.confirmMapper = confirmMapper;
window.applyMapping = applyMapping;
window.handleCsvFile = handleCsvFile;
window.handleCsvDrop = handleCsvDrop;
window.processCsvFile = processCsvFile;
window.resetCsv = resetCsv;
window.doUploadCsv = doUploadCsv;
window.doDownloadSample = doDownloadSample;
window.doSyncSets = doSyncSets;
window.loadProductSets = loadProductSets;
window.onSetTypeChange = onSetTypeChange;
window.openCreateSetModal = openCreateSetModal;
window.openEditSetModal = openEditSetModal;
window.closeSetModal = closeSetModal;
window.doSaveSet = doSaveSet;
window.doDeleteSet = doDeleteSet;
window.doAutoCreateSets = doAutoCreateSets;
window.doSyncAllSets = doSyncAllSets;
window.loadCollections = loadCollections;
window.setupCollDragDrop = setupCollDragDrop;
window.openCreateCollModal = openCreateCollModal;
window.openEditCollModal = openEditCollModal;
window.loadCollSetsPicker = loadCollSetsPicker;
window.closeCollModal = closeCollModal;
window.doSaveColl = doSaveColl;
window.doDeleteColl = doDeleteColl;
window.doAutoCreateCollections = doAutoCreateCollections;
window.doSyncAllCollections = doSyncAllCollections;
// window.doSyncBranchCollections — REMOVED. The function is defined and
// exported by settings.js (where it actually lives). The dangling reference
// here threw a ReferenceError that aborted menu.js's IIFE before later
// exports (openVarModal, loadImageStats, doBulkImageUpload, etc.) ran.
window.openVarModal = openVarModal;
window.closeVarModal = closeVarModal;
window.doAddVariant = doAddVariant;
window.syncImgPreview = syncImgPreview;
window.handleImgFile = handleImgFile;
window.resetImgPicker = resetImgPicker;
window.updateImgQuality = updateImgQuality;
window.loadImageStats = loadImageStats;
window.openBulkImageUpload = openBulkImageUpload;
window.closeBulkImageUpload = closeBulkImageUpload;
window.updateBulkFileList = updateBulkFileList;
window.doBulkImageUpload = doBulkImageUpload;

})();
