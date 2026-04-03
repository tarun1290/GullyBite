// frontend/js/tabs/restaurant.js
// Dashboard tab: Restaurant (Customers, Ratings, Team, Loyalty, Referrals, Coupons, Campaigns)

(function() {

// ─── RESTAURANT PROFILE (read-only) ─────────────────────
async function loadRestaurantProfile() {
  try {
    var r = await api('/auth/me');
    if (!r) return;

    // ── Header only (info cards moved to Settings page) ──
    var name = r.business_name || r.brand_name || 'Restaurant';
    var el = function(id) { return document.getElementById(id); };
    if (el('rp-avatar')) el('rp-avatar').textContent = name[0].toUpperCase();
    if (el('rp-name')) el('rp-name').textContent = name;
    if (el('rp-legal-name')) { el('rp-legal-name').textContent = r.registered_business_name || ''; el('rp-legal-name').style.display = r.registered_business_name ? '' : 'none'; }

    var typeLabels = { both: 'Veg & Non-Veg', veg: 'Pure Veg', non_veg: 'Non-Veg' };
    if (el('rp-type-badge')) el('rp-type-badge').textContent = typeLabels[r.restaurant_type] || r.restaurant_type || '';
    if (el('rp-approval-badge')) {
      var approved = r.approval_status === 'approved';
      el('rp-approval-badge').textContent = approved ? '\u2705 Approved' : '\u23F3 Pending Approval';
      el('rp-approval-badge').style.background = approved ? '#dcfce7' : '#fef3c7';
      el('rp-approval-badge').style.color = approved ? '#15803d' : '#92400e';
    }
    if (el('rp-city-badge')) { el('rp-city-badge').textContent = r.city || ''; el('rp-city-badge').style.display = r.city ? '' : 'none'; }

  } catch (e) {
    console.warn('[Profile] Load failed:', e.message);
  }
}

let _custSearch = '';
let _custDebounce;

function debounceCustSearch() {
  clearTimeout(_custDebounce);
  _custDebounce = setTimeout(() => {
    _custSearch = document.getElementById('cust-search')?.value || '';
    loadCustomers();
  }, 350);
}

async function loadCustomers() {
  const el = document.getElementById('cust-list');
  if (!el) return;
  el.innerHTML = '<div class="empty"><div class="ei">⏳</div><h3>Loading…</h3></div>';
  try {
    const qs = _custSearch ? `?search=${encodeURIComponent(_custSearch)}` : '';
    const custs = await api(`/api/restaurant/customers${qs}`);
    if (!custs.length) {
      el.innerHTML = '<div class="empty"><div class="ei">👥</div><h3>No customers yet</h3><p>Orders placed via WhatsApp will appear here.</p></div>';
      return;
    }
    el.innerHTML = custs.map(c => `
      <div class="order-row" style="cursor:pointer" onclick="toggleCustHistory('${c.id}',this)">
        <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
          <div style="font-weight:600">${c.name || 'Unknown'}</div>
          <div style="color:var(--dim);font-size:.85rem">${c.wa_phone ? '+'+c.wa_phone : c.bsuid?.slice(0,12)+'…' || '—'}</div>
          <div style="margin-left:auto;display:flex;gap:1rem;font-size:.85rem">
            <span title="Total orders">🛒 ${c.total_orders}</span>
            <span title="Total spent">💰 ₹${(c.total_spent||0).toFixed(0)}</span>
            ${c.last_order_at ? `<span style="color:var(--dim)">${new Date(c.last_order_at).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}</span>` : ''}
          </div>
        </div>
        <div id="ch-${c.id}" style="display:none;margin-top:1rem"></div>
      </div>
    `).join('');
  } catch(e) {
    el.innerHTML = `<div class="empty"><div class="ei">❌</div><h3>${e.message}</h3></div>`;
  }
}

async function toggleCustHistory(custId, row) {
  const hist = document.getElementById(`ch-${custId}`);
  if (!hist) return;
  if (hist.style.display !== 'none') { hist.style.display = 'none'; return; }
  hist.style.display = 'block';
  hist.innerHTML = '<div style="color:var(--dim);font-size:.85rem;padding:.5rem 0">Loading order history…</div>';
  try {
    const orders = await api(`/api/restaurant/customers/${custId}/orders`);
    if (!orders.length) { hist.innerHTML = '<div style="color:var(--dim);font-size:.85rem">No orders found.</div>'; return; }
    hist.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.85rem;margin-top:.5rem">
        <thead><tr style="color:var(--dim);text-align:left">
          <th style="padding:.4rem .6rem">Order #</th>
          <th style="padding:.4rem .6rem">Branch</th>
          <th style="padding:.4rem .6rem">Items</th>
          <th style="padding:.4rem .6rem">Total</th>
          <th style="padding:.4rem .6rem">Status</th>
          <th style="padding:.4rem .6rem">Date</th>
        </tr></thead>
        <tbody>${orders.map(o => `
          <tr style="border-top:1px solid var(--border)">
            <td style="padding:.4rem .6rem;font-weight:600">#${o.order_number}</td>
            <td style="padding:.4rem .6rem">${o.branch_name}</td>
            <td style="padding:.4rem .6rem">${o.items.map(i=>`${i.qty}x ${i.name}`).join(', ')}</td>
            <td style="padding:.4rem .6rem">₹${o.total_rs}</td>
            <td style="padding:.4rem .6rem">${sbadge(o.status)}</td>
            <td style="padding:.4rem .6rem;color:var(--dim)">${new Date(o.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch(e) {
    hist.innerHTML = `<div style="color:var(--danger);font-size:.85rem">${e.message}</div>`;
  }
}

// Modal reuse: show customer order history from the Orders tab
async function showCustOrderHistory(custId, custName) {
  const modal = document.getElementById('ord-modal');
  const body  = document.getElementById('ord-modal-body');
  const title = document.getElementById('ord-modal-title');
  modal.style.display = 'flex';
  title.textContent = `Order History — ${custName}`;
  body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--dim)">Loading…</div>';
  try {
    const orders = await api(`/api/restaurant/customers/${custId}/orders`);
    if (!orders.length) { body.innerHTML = '<p style="padding:1rem;color:var(--dim)">No orders found for this customer.</p>'; return; }
    body.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.85rem">
        <thead><tr style="color:var(--dim);text-align:left;border-bottom:2px solid var(--border)">
          <th style="padding:.5rem .6rem">Order #</th>
          <th style="padding:.5rem .6rem">Branch</th>
          <th style="padding:.5rem .6rem">Items</th>
          <th style="padding:.5rem .6rem">Total</th>
          <th style="padding:.5rem .6rem">Status</th>
          <th style="padding:.5rem .6rem">Date</th>
        </tr></thead>
        <tbody>${orders.map(o => `
          <tr style="border-top:1px solid var(--border)">
            <td style="padding:.45rem .6rem;font-weight:600">#${o.order_number}</td>
            <td style="padding:.45rem .6rem">${o.branch_name}</td>
            <td style="padding:.45rem .6rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${o.items.map(i=>`${i.qty}x ${i.name}`).join(', ')}</td>
            <td style="padding:.45rem .6rem">₹${o.total_rs}</td>
            <td style="padding:.45rem .6rem">${sbadge(o.status)}</td>
            <td style="padding:.45rem .6rem;color:var(--dim)">${new Date(o.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch(e) {
    body.innerHTML = `<div style="padding:1rem;color:var(--danger)">${e.message}</div>`;
  }
}


let _rtPage = 1;
async function loadRatings(page) {
  _rtPage = page || 1;
  try {
    // Populate branch filter if empty
    const brSel = document.getElementById('rt-branch');
    if (brSel.options.length <= 1) {
      const brs = await api('/api/restaurant/branches');
      (brs || []).forEach(b => { const o = document.createElement('option'); o.value = b.id; o.textContent = b.name; brSel.appendChild(o); });
    }
    const branchFilter = brSel.value;
    const qb = branchFilter ? `&branch_id=${branchFilter}` : '';

    // Load summary — 6 category cards
    const sum = await api(`/api/restaurant/ratings/summary?${qb}`);
    const rClr = (v) => v >= 4 ? 'var(--wa)' : v >= 3 ? 'var(--gold)' : v > 0 ? 'var(--red)' : 'var(--dim)';
    const el = (id) => document.getElementById(id);
    if (el('rt-avg-overall')) { el('rt-avg-overall').textContent = sum.total ? sum.avg_overall : '\u2014'; el('rt-avg-overall').style.color = rClr(sum.avg_overall); }
    if (el('rt-avg-taste')) { el('rt-avg-taste').textContent = sum.total ? sum.avg_taste : '\u2014'; el('rt-avg-taste').style.color = rClr(sum.avg_taste); }
    if (el('rt-avg-packing')) { el('rt-avg-packing').textContent = sum.total ? sum.avg_packing : '\u2014'; el('rt-avg-packing').style.color = rClr(sum.avg_packing); }
    if (el('rt-avg-delivery')) { el('rt-avg-delivery').textContent = sum.total ? sum.avg_delivery : '\u2014'; el('rt-avg-delivery').style.color = rClr(sum.avg_delivery); }
    if (el('rt-avg-value')) { el('rt-avg-value').textContent = sum.total ? sum.avg_value : '\u2014'; el('rt-avg-value').style.color = rClr(sum.avg_value); }
    if (el('rt-total')) el('rt-total').textContent = sum.total || '0';

    // Recent comments
    const commentsEl = el('rt-comments');
    if (commentsEl) {
      if (sum.recent_comments?.length) {
        commentsEl.innerHTML = sum.recent_comments.map(c => {
          const clr = (c.overall_rating || 0) >= 4 ? 'var(--wa)' : (c.overall_rating || 0) >= 3 ? 'var(--gold)' : 'var(--red)';
          return '<div style="padding:.5rem 0;border-bottom:1px solid var(--rim)"><span style="font-weight:600;color:' + clr + '">' + (c.overall_rating || 0) + '\u2B50</span> <span>' + (c.comment || '') + '</span> <span style="color:var(--dim);font-size:.72rem;float:right">' + new Date(c.created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short' }) + '</span></div>';
        }).join('');
      } else { commentsEl.innerHTML = '<span style="color:var(--mute)">No comments yet</span>'; }
    }

    // Load paginated ratings
    const data = await api(`/api/restaurant/ratings?page=${_rtPage}&limit=20${qb}`);
    document.getElementById('rt-count').textContent = `${data.total} total`;
    const tb = document.getElementById('rt-tbody');
    if (!data.ratings.length) {
      tb.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--dim)">No ratings yet. Ratings will appear here after customers rate their orders.</td></tr>';
    } else {
      const badge = (v) => { const c = v >= 4 ? 'var(--wa)' : v === 3 ? 'var(--gold)' : v > 0 ? 'var(--red)' : 'var(--dim)'; return '<span style="color:' + c + ';font-weight:600">' + (v || '\u2014') + '</span>'; };
      tb.innerHTML = data.ratings.map(r => {
        const date = new Date(r.created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'2-digit' });
        return `<tr style="border-bottom:1px solid var(--rim)">
          <td style="padding:.5rem">#${r.order_number}</td>
          <td style="padding:.5rem">${r.customer_name}</td>
          <td style="padding:.5rem">${r.branch_name}</td>
          <td style="padding:.5rem;text-align:center">${badge(r.taste_rating)}</td>
          <td style="padding:.5rem;text-align:center">${badge(r.packing_rating)}</td>
          <td style="padding:.5rem;text-align:center">${badge(r.delivery_rating)}</td>
          <td style="padding:.5rem;text-align:center">${badge(r.value_rating)}</td>
          <td style="padding:.5rem;text-align:center">${badge(r.overall_rating)}</td>
          <td style="padding:.5rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.comment||'').replace(/"/g,'&quot;')}">${r.comment || '<span style="color:var(--mute)">\u2014</span>'}</td>
          <td style="padding:.5rem;color:var(--dim)">${date}</td>
        </tr>`;
      }).join('');
    }

    // Pager
    const pager = document.getElementById('rt-pager');
    if (data.pages > 1) {
      pager.innerHTML = Array.from({ length: data.pages }, (_, i) => i + 1)
        .map(p => `<button onclick="loadRatings(${p})" style="padding:.3rem .6rem;border:1px solid ${p===_rtPage?'var(--acc)':'var(--rim)'};border-radius:var(--r);background:${p===_rtPage?'var(--acc)':'#fff'};color:${p===_rtPage?'#fff':'var(--tx)'};cursor:pointer;font-size:.75rem">${p}</button>`)
        .join('');
    } else { pager.innerHTML = ''; }
  } catch (e) { toast(e.message, 'err'); }
}


let _currentUser = null;

function applyPermissions(user) {
  _currentUser = user;
  const p = user?.permissions || {};
  const role = user?.role || 'owner';

  // Show/hide sidebar sections based on permissions
  const hide = (sel) => { const el = document.querySelector(sel); if (el) el.style.display = 'none'; };
  const show = (sel) => { const el = document.querySelector(sel); if (el) el.style.display = ''; };

  if (!p.view_analytics && role !== 'owner') hide('.sb-btn[onclick*="analytics"]');
  if (!p.manage_settings && role !== 'owner') { hide('.sb-btn[onclick*="settings"]'); hide('.sb-btn[onclick*="integrations"]'); }
  if (!p.manage_coupons && role !== 'owner') hide('.sb-btn[onclick*="coupons"]');
  if (!p.view_payments && role !== 'owner') { hide('.sb-btn[onclick*="settlements"]'); hide('.sb-btn[onclick*="financials"]'); }
  if (!p.view_menu && role !== 'owner') hide('.sb-btn[onclick*="menu"]');
  if (p.manage_users || role === 'owner') show('#sb-team-sec');

  // Update sidebar footer
  const rl = document.getElementById('sb-rl');
  if (rl) {
    const labels = { owner: '👑 Owner', manager: '📋 Manager', kitchen: '👨‍🍳 Kitchen', delivery: '🚴 Delivery' };
    rl.textContent = labels[role] || role;
  }
  const nm = document.getElementById('sb-nm');
  if (nm && user?.name) nm.textContent = user.name;
}

async function doPinLogin() {
  const rid   = document.getElementById('pin-rid').value.trim();
  const phone = document.getElementById('pin-phone').value.trim();
  const pin   = document.getElementById('pin-code').value.trim();
  if (!rid || !phone || !pin) { toast('All fields required', 'err'); return; }
  try {
    const res = await fetch('/auth/pin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId: rid, phone, pin }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Login failed', 'err'); return; }
    localStorage.setItem('zm_token', data.token);
    token = data.token;
    document.getElementById('pin-login-screen').style.display = 'none';
    applyPermissions(data.user);
    goTab('orders', document.querySelector('.sb-btn[onclick*="orders"]'));
  } catch (e) { toast(e.message, 'err'); }
}

async function loadTeam() {
  const tb = document.getElementById('team-tbody');
  try {
    const users = await api('/api/restaurant/users');
    const branches = await api('/api/restaurant/branches');
    const brMap = Object.fromEntries((branches||[]).map(b => [b.id, b.name]));
    if (!users.length) {
      tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--dim)">No team members yet.</td></tr>';
      return;
    }
    const roleBadge = (r) => {
      const m = { owner:'👑', manager:'📋', kitchen:'👨‍🍳', delivery:'🚴' };
      const c = { owner:'var(--acc)', manager:'var(--wa)', kitchen:'var(--gold)', delivery:'var(--blue)' };
      return `<span style="color:${c[r]||'var(--dim)'};font-weight:600">${m[r]||''} ${r.charAt(0).toUpperCase()+r.slice(1)}</span>`;
    };
    tb.innerHTML = users.map(u => {
      const brNames = (u.branch_ids||[]).length ? u.branch_ids.map(id => brMap[id]||id).join(', ') : 'All';
      const lastLogin = u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : 'Never';
      const actions = u.role === 'owner' ? '<span style="color:var(--mute);font-size:.75rem">Owner</span>' : `
        <button class="btn-outline btn-sm" onclick="editUser('${u.id}')">Edit</button>
        <button class="btn-outline btn-sm" style="color:var(--gold)" onclick="resetUserPin('${u.id}','${u.name.replace(/'/g,"\\'")}')">PIN</button>
        <button class="btn-outline btn-sm" style="color:var(--red)" onclick="toggleUser('${u.id}',${u.is_active},'${u.name.replace(/'/g,"\\'")}')">${u.is_active?'Deactivate':'Activate'}</button>`;
      return `<tr style="border-bottom:1px solid var(--rim);${!u.is_active?'opacity:.5':''}">
        <td style="padding:.5rem">${u.name}</td>
        <td style="padding:.5rem;font-size:.75rem;color:var(--dim)">${u.phone}</td>
        <td style="padding:.5rem;text-align:center">${roleBadge(u.role)}</td>
        <td style="padding:.5rem;font-size:.75rem">${brNames}</td>
        <td style="padding:.5rem;text-align:center">${u.is_active?'<span style="color:var(--wa)">✓</span>':'<span style="color:var(--red)">✗</span>'}</td>
        <td style="padding:.5rem;font-size:.75rem;color:var(--dim)">${lastLogin}</td>
        <td style="padding:.5rem;text-align:center">${actions}</td>
      </tr>`;
    }).join('');
  } catch (e) { toast(e.message, 'err'); }
}

async function openAddUserModal(editId) {
  document.getElementById('user-modal').style.display = 'flex';
  document.getElementById('u-edit-id').value = editId || '';
  document.getElementById('user-modal-title').textContent = editId ? 'Edit Team Member' : 'Add Team Member';
  if (!editId) { document.getElementById('u-name').value=''; document.getElementById('u-phone').value=''; document.getElementById('u-pin').value=''; document.getElementById('u-role').value='manager'; }

  // Populate branch checkboxes
  const brDiv = document.getElementById('u-branches');
  try {
    const branches = await api('/api/restaurant/branches');
    brDiv.innerHTML = (branches||[]).map(b =>
      `<label style="display:flex;align-items:center;gap:.3rem;font-size:.8rem;padding:.2rem .5rem;border:1px solid var(--rim);border-radius:4px;cursor:pointer"><input type="checkbox" class="u-br-cb" value="${b.id}"> ${b.name}</label>`
    ).join('');
  } catch (_) {}
}
function closeUserModal() { document.getElementById('user-modal').style.display = 'none'; }

async function doSaveUser() {
  const editId = document.getElementById('u-edit-id').value;
  const name   = document.getElementById('u-name').value.trim();
  const phone  = document.getElementById('u-phone').value.trim();
  const pin    = document.getElementById('u-pin').value.trim();
  const role   = document.getElementById('u-role').value;
  const branchIds = [...document.querySelectorAll('.u-br-cb:checked')].map(c => c.value);

  if (!name) { toast('Name is required', 'err'); return; }

  try {
    if (editId) {
      await api(`/api/restaurant/users/${editId}`, { method: 'PUT', body: { name, role, branchIds } });
      toast('User updated', 'ok');
    } else {
      if (!phone || !pin) { toast('Phone and PIN are required', 'err'); return; }
      await api('/api/restaurant/users', { method: 'POST', body: { name, phone, pin, role, branchIds } });
      toast('User created', 'ok');
    }
    closeUserModal();
    loadTeam();
  } catch (e) { toast(e.message, 'err'); }
}

async function editUser(id) {
  try {
    const users = await api('/api/restaurant/users');
    const u = users.find(x => x.id === id);
    if (!u) return;
    await openAddUserModal(id);
    document.getElementById('u-name').value = u.name;
    document.getElementById('u-phone').value = u.phone;
    document.getElementById('u-role').value = u.role;
    // Check branch checkboxes
    (u.branch_ids||[]).forEach(bid => {
      const cb = document.querySelector(`.u-br-cb[value="${bid}"]`);
      if (cb) cb.checked = true;
    });
  } catch (e) { toast(e.message, 'err'); }
}

async function resetUserPin(id, name) {
  const pin = prompt(`Enter new PIN for ${name} (4-6 digits):`);
  if (!pin) return;
  try {
    await api(`/api/restaurant/users/${id}/reset-pin`, { method: 'PUT', body: { pin } });
    toast('PIN reset successfully', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function toggleUser(id, isActive, name) {
  if (isActive && !confirm(`Deactivate ${name}?`)) return;
  try {
    if (isActive) {
      await api(`/api/restaurant/users/${id}`, { method: 'DELETE' });
    } else {
      await api(`/api/restaurant/users/${id}`, { method: 'PUT', body: { isActive: true } });
    }
    toast(isActive ? 'User deactivated' : 'User activated', 'ok');
    loadTeam();
  } catch (e) { toast(e.message, 'err'); }
}


let _lyPage = 1;
async function loadLoyalty(page) {
  _lyPage = page || 1;
  // Populate WhatsApp info card from restaurant data
  if (rest) {
    const waPhone = rest.wa_phone_number || rest.waba_accounts?.[0]?.phone || rest.waba_accounts?.[0]?.wa_phone_number;
    const waConnected = !!(waPhone || rest.whatsapp_connected || rest.meta_user_id || rest.waba_accounts?.length);
    document.getElementById('wa-info-phone').innerHTML = waPhone
      ? `<span style="color:var(--wa)">${waPhone} ✅</span>`
      : waConnected
        ? `<span style="color:var(--wa)">Connected ✅</span>`
        : '<span style="color:var(--red)">Not Connected ❌</span>';
    const catId = rest.meta_catalog_id || rest.catalog_id;
    document.getElementById('wa-info-catalog').innerHTML = catId
      ? `<span style="color:var(--wa)">${catId} ✅</span>`
      : '<span style="color:var(--red)">No catalog ❌</span>';
    document.getElementById('wa-info-waba').textContent = rest.meta_waba_id || rest.waba_accounts?.[0]?.waba_id || '—';
  }
  try {
    // Load stats
    const stats = await api('/api/restaurant/loyalty/stats');
    document.getElementById('ly-members').textContent = stats.total_members || '0';
    document.getElementById('ly-issued').textContent = (stats.total_points_issued || 0).toLocaleString();
    document.getElementById('ly-redeemed').textContent = (stats.total_points_redeemed || 0).toLocaleString();
    const tiers = stats.tiers || {};
    document.getElementById('ly-tiers').innerHTML = [
      { k:'platinum', l:'💎 Platinum', c:'var(--acc)' },
      { k:'gold', l:'🥇 Gold', c:'var(--gold)' },
      { k:'silver', l:'🥈 Silver', c:'var(--blue)' },
      { k:'bronze', l:'🥉 Bronze', c:'var(--dim)' },
    ].map(t => `<div style="display:flex;justify-content:space-between;margin:.15rem 0"><span style="color:${t.c}">${t.l}</span><strong>${tiers[t.k]||0}</strong></div>`).join('');

    // Load paginated customers
    const data = await api(`/api/restaurant/loyalty/customers?page=${_lyPage}&limit=20`);
    document.getElementById('ly-count').textContent = `${data.total} members`;
    const tb = document.getElementById('ly-tbody');
    if (!data.customers.length) {
      tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--dim)">No loyalty members yet. Points are earned automatically after each delivered order.</td></tr>';
    } else {
      const tierBadge = (t) => {
        const m = { platinum:'💎', gold:'🥇', silver:'🥈', bronze:'🥉' };
        const c = { platinum:'var(--acc)', gold:'var(--gold)', silver:'var(--blue)', bronze:'var(--dim)' };
        return `<span style="color:${c[t]||'var(--dim)'};font-weight:600">${m[t]||'🥉'} ${t.charAt(0).toUpperCase()+t.slice(1)}</span>`;
      };
      tb.innerHTML = data.customers.map(c => `<tr style="border-bottom:1px solid var(--rim)">
        <td style="padding:.5rem">${c.customer_name}</td>
        <td style="padding:.5rem;font-size:.75rem;color:var(--dim)">${c.wa_phone || c.bsuid?.slice(0,12)+'…' || '—'}</td>
        <td style="padding:.5rem;text-align:center;font-weight:600">${c.points_balance}</td>
        <td style="padding:.5rem;text-align:center;color:var(--dim)">${c.lifetime_points}</td>
        <td style="padding:.5rem;text-align:center">${tierBadge(c.tier)}</td>
        <td style="padding:.5rem;text-align:center">${c.total_orders}</td>
        <td style="padding:.5rem;text-align:right">₹${parseFloat(c.total_spent_rs||0).toFixed(0)}</td>
      </tr>`).join('');
    }

    // Pager
    const pager = document.getElementById('ly-pager');
    if (data.pages > 1) {
      pager.innerHTML = Array.from({ length: data.pages }, (_, i) => i + 1)
        .map(p => `<button onclick="loadLoyalty(${p})" style="padding:.3rem .6rem;border:1px solid ${p===_lyPage?'var(--acc)':'var(--rim)'};border-radius:var(--r);background:${p===_lyPage?'var(--acc)':'#fff'};color:${p===_lyPage?'#fff':'var(--tx)'};cursor:pointer;font-size:.75rem">${p}</button>`)
        .join('');
    } else { pager.innerHTML = ''; }
  } catch (e) { toast(e.message, 'err'); }
}


async function loadReferrals() {
  try {
    const d = await api('/api/restaurant/referrals'); if (!d) return;
    const s = d.summary;
    document.getElementById('rr-total').textContent       = s.total;
    document.getElementById('rr-converted').textContent   = s.converted + (s.total > 0 ? ` (${Math.round(s.converted / s.total * 100)}%)` : '');
    document.getElementById('rr-order-value').textContent = '₹' + parseFloat(s.total_order_value_rs).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    const gst = parseFloat(s.total_referral_fee_rs) * 0.18;
    document.getElementById('rr-fee').textContent         = '₹' + (parseFloat(s.total_referral_fee_rs) + gst).toLocaleString('en-IN', { minimumFractionDigits: 2 });

    const tbody = document.getElementById('rr-tbody');
    if (!d.referrals.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:2rem;text-align:center;color:var(--dim)">No referrals received yet</td></tr>';
      return;
    }
    const statusColor = { active:'#22c55e', converted:'#a78bfa', expired:'#6b7280' };
    tbody.innerHTML = d.referrals.map(r => `
      <tr style="border-bottom:1px solid var(--rim)">
        <td style="padding:.6rem 1rem">
          <div style="font-family:monospace;font-size:.8rem">${r.customer_wa_phone || r.customer_bsuid?.slice(0,12)+'…' || '—'}</div>
          ${r.customer_name ? `<div style="font-size:.74rem;color:var(--dim)">${r.customer_name}</div>` : ''}
        </td>
        <td style="padding:.6rem 1rem">
          <span style="color:${statusColor[r.status]||'#6b7280'};font-weight:600;text-transform:capitalize;font-size:.8rem">${r.status}</span>
        </td>
        <td style="padding:.6rem 1rem">${r.orders_count}</td>
        <td style="padding:.6rem 1rem">₹${parseFloat(r.total_order_value_rs).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
        <td style="padding:.6rem 1rem;color:#a78bfa;font-weight:600">₹${parseFloat(r.referral_fee_rs).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
        <td style="padding:.6rem 1rem;font-size:.78rem;color:var(--dim)">${new Date(r.created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}</td>
      </tr>`).join('');
  } catch (e) { toast(e.message, 'err'); }
}


function toggleCouponTypeFields() {
  const isPercent = document.getElementById('cp-type').value === 'percent';
  document.getElementById('cp-maxdis-wrap').style.display = isPercent ? '' : 'none';
}

async function loadCoupons() {
  const tbody = document.getElementById('cp-tbody');
  try {
    const d = await api('/api/restaurant/coupons'); if (!d) return;
    if (!d.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:2rem;text-align:center;color:var(--dim)">No coupons yet — create one above</td></tr>';
      return;
    }
    tbody.innerHTML = d.map(c => {
      const discountLabel = c.discount_type === 'percent'
        ? `${parseFloat(c.discount_value).toFixed(0)}%${c.max_discount_rs ? ` (max ₹${parseFloat(c.max_discount_rs).toFixed(0)})` : ''}`
        : `₹${parseFloat(c.discount_value).toFixed(0)} flat`;
      const validFrom  = c.valid_from  ? new Date(c.valid_from).toLocaleDateString('en-IN',  { day:'numeric', month:'short', year:'numeric' }) : '—';
      const validUntil = c.valid_until ? new Date(c.valid_until).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) : '—';
      const usedLabel  = c.usage_limit ? `${c.usage_count ?? 0} / ${c.usage_limit}` : `${c.usage_count ?? 0} / ∞`;
      const isActive   = c.is_active;
      return `<tr style="border-bottom:1px solid var(--rim)">
        <td style="padding:.65rem 1rem;font-family:monospace;font-weight:700;letter-spacing:.05em">${c.code}</td>
        <td style="padding:.65rem 1rem">${discountLabel}</td>
        <td style="padding:.65rem 1rem">₹${parseFloat(c.min_order_rs||0).toFixed(0)}</td>
        <td style="padding:.65rem 1rem">${usedLabel}</td>
        <td style="padding:.65rem 1rem;font-size:.8rem">${validFrom} → ${validUntil}</td>
        <td style="padding:.65rem 1rem">
          <span style="font-size:.78rem;font-weight:600;color:${isActive ? '#22c55e' : '#6b7280'}">${isActive ? 'Active' : 'Inactive'}</span>
        </td>
        <td style="padding:.65rem 1rem;display:flex;gap:.5rem">
          <button class="btn btn-sm" style="padding:.25rem .6rem;font-size:.78rem;background:${isActive ? '#374151' : 'var(--acc)'}"
            onclick="toggleCoupon('${c.id}',${!isActive})">${isActive ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-sm" style="padding:.25rem .6rem;font-size:.78rem;background:#7f1d1d;color:#fca5a5"
            onclick="deleteCoupon('${c.id}','${c.code}')">Delete</button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) { toast(e.message, 'err'); }
}

async function createCoupon() {
  const code  = (document.getElementById('cp-code').value  || '').trim().toUpperCase();
  const type  =  document.getElementById('cp-type').value;
  const value =  parseFloat(document.getElementById('cp-value').value);
  if (!code)        return toast('Coupon code is required', 'err');
  if (!value || value <= 0) return toast('Discount value must be > 0', 'err');

  const body = {
    code,
    description : document.getElementById('cp-desc').value.trim() || null,
    discountType: type,
    discountValue: value,
    minOrderRs  : parseFloat(document.getElementById('cp-min').value)    || 0,
    maxDiscountRs: parseFloat(document.getElementById('cp-maxdis').value) || null,
    usageLimit  : parseInt(document.getElementById('cp-limit').value)    || null,
    validFrom   : document.getElementById('cp-from').value  || null,
    validUntil  : document.getElementById('cp-until').value || null,
  };

  try {
    await api('/api/restaurant/coupons', { method: 'POST', body });
    toast('Coupon created!', 'ok');
    ['cp-code','cp-desc','cp-value','cp-min','cp-maxdis','cp-limit','cp-from','cp-until'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('cp-type').value = 'percent';
    toggleCouponTypeFields();
    loadCoupons();
  } catch (e) { toast(e.message, 'err'); }
}

async function toggleCoupon(id, active) {
  try {
    await api(`/api/restaurant/coupons/${id}`, { method: 'PATCH', body: { isActive: active } });
    loadCoupons();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteCoupon(id, code) {
  if (!confirm(`Delete coupon "${code}"? This cannot be undone.`)) return;
  try {
    await api(`/api/restaurant/coupons/${id}`, { method: 'DELETE' });
    toast('Coupon deleted', 'ok');
    loadCoupons();
  } catch (e) { toast(e.message, 'err'); }
}


let cmpProducts = []; // products for selected branch

async function loadCampaigns() {
  // Populate branch dropdown
  const sel = document.getElementById('cmp-branch');
  sel.innerHTML = '<option value="">Select branch…</option>' +
    branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('');

  const tb = document.getElementById('cmp-tbody');
  try {
    const rows = await api('/api/restaurant/campaigns');
    if (!rows?.length) {
      tb.innerHTML = '<tr><td colspan="8"><div class="empty"><div class="ei">📢</div><h3>No campaigns yet</h3><p>Create your first campaign above</p></div></td></tr>';
      return;
    }
    const segLabel = { all: 'All', recent: 'Recent 30d', inactive: 'Inactive 60d+' };
    tb.innerHTML = rows.map(c => {
      const statusMap = { draft: 'bd', scheduled: 'bb', sending: 'bb', paused: 'bb', sent: 'bg', failed: 'br' };
      const s = c.stats || {};
      const total = s.total_recipients || c.sent_count || 0;
      const sentCount = s.sent || c.sent_count || 0;
      const failedCount = s.failed || c.failed_count || 0;
      const deliveredCount = s.delivered || 0;
      const readCount = s.read || 0;
      // Batch progress
      const batchInfo = (c.status === 'sending' || c.status === 'paused') && c.total_batches
        ? `<div style="font-size:.72rem;color:var(--dim);margin-top:.2rem">Batch ${c.current_batch || 0} / ${c.total_batches} &middot; ${sentCount} / ${total} sent</div>` : '';
      // Delivery stats
      const deliveryStats = sentCount > 0
        ? `<div style="font-size:.72rem;margin-top:.2rem">` +
          `<span style="color:#22c55e">Delivered: ${deliveredCount} (${total > 0 ? Math.round(deliveredCount/sentCount*100) : 0}%)</span> ` +
          `<span style="color:#3b82f6">Read: ${readCount} (${sentCount > 0 ? Math.round(readCount/sentCount*100) : 0}%)</span> ` +
          `<span style="color:var(--red)">Failed: ${failedCount} (${sentCount > 0 ? Math.round(failedCount/sentCount*100) : 0}%)</span>` +
          `</div>` : '';
      // High failure warning
      const failWarning = failedCount > 0 && sentCount > 0 && (failedCount / sentCount) > 0.1
        ? `<div style="background:#fef2f2;color:#991b1b;font-size:.72rem;padding:.25rem .5rem;border-radius:4px;margin-top:.3rem">High failure rate — Meta may be pacing this campaign</div>` : '';
      // Pause reason
      const pauseInfo = c.status === 'paused' && c.pause_reason
        ? `<div style="background:#fef9c3;color:#854d0e;font-size:.72rem;padding:.25rem .5rem;border-radius:4px;margin-top:.3rem">${esc(c.pause_reason)}</div>` : '';

      return `<tr>
        <td><strong>${esc(c.name)}</strong>${batchInfo}${deliveryStats}${failWarning}${pauseInfo}</td>
        <td>${c.product_ids?.length || 0}</td>
        <td>${segLabel[c.segment] || c.segment}</td>
        <td>${sentCount}</td>
        <td>${failedCount}</td>
        <td><span class="badge ${statusMap[c.status] || 'bd'}">${c.status}</span></td>
        <td style="font-size:.78rem;color:var(--dim)">${timeAgo(c.created_at)}</td>
        <td style="white-space:nowrap">
          ${c.status === 'draft' || c.status === 'scheduled' ? `<button class="btn-g btn-sm" onclick="sendCampaignNow('${c.id || c._id}')">Send</button> ` : ''}
          ${c.status === 'sending' ? `<button class="btn-sm" style="background:#eab308;color:#fff" onclick="pauseCampaignNow('${c.id || c._id}')">Pause</button> ` : ''}
          ${c.status === 'paused' ? `<button class="btn-g btn-sm" onclick="resumeCampaignNow('${c.id || c._id}')">Resume</button> ` : ''}
          ${c.status !== 'sending' ? `<button class="btn-sm" style="color:var(--red)" onclick="deleteCampaignRow('${c.id || c._id}','${esc(c.name)}')">Delete</button>` : ''}
        </td>
      </tr>`;
    }).join('');
  } catch (_) {}
}

async function loadCampaignProducts() {
  const branchId = document.getElementById('cmp-branch').value;
  const container = document.getElementById('cmp-products');
  if (!branchId) { container.innerHTML = '<span style="color:var(--dim);font-size:.82rem">Select a branch first</span>'; return; }

  try {
    const items = await api(`/api/restaurant/branches/${branchId}/items`);
    cmpProducts = items || [];
    if (!cmpProducts.length) { container.innerHTML = '<span style="color:var(--dim);font-size:.82rem">No menu items found for this branch</span>'; return; }

    container.innerHTML = cmpProducts.map(item => `
      <label style="display:flex;align-items:center;gap:.5rem;padding:.3rem .4rem;border-radius:6px;cursor:pointer;font-size:.82rem" class="cmp-prod-row">
        <input type="checkbox" value="${item.id}" class="cmp-prod-cb" onchange="updateCmpCount()">
        <span>${item.food_type === 'veg' ? '🟢' : '🔴'}</span>
        <span style="flex:1">${item.name}${item.variant_value ? ' — ' + item.variant_value : ''}</span>
        <span style="color:var(--dim)">₹${((item.price_paise || 0) / 100).toFixed(0)}</span>
      </label>`).join('');
  } catch (e) { container.innerHTML = `<span style="color:var(--red);font-size:.82rem">${e.message}</span>`; }
}

function updateCmpCount() {
  const checked = document.querySelectorAll('.cmp-prod-cb:checked');
  document.getElementById('cmp-sel-count').textContent = checked.length;
  if (checked.length > 30) {
    alert('Maximum 30 products per campaign');
    checked[checked.length - 1].checked = false;
    document.getElementById('cmp-sel-count').textContent = 30;
  }
}

function getCmpBody() {
  const name = document.getElementById('cmp-name').value.trim();
  const branchId = document.getElementById('cmp-branch').value;
  const productIds = [...document.querySelectorAll('.cmp-prod-cb:checked')].map(cb => cb.value);
  if (!name) { toast('Enter a campaign name', 'err'); return null; }
  if (!branchId) { toast('Select a branch', 'err'); return null; }
  if (!productIds.length) { toast('Select at least one product', 'err'); return null; }

  return {
    branchId,
    name,
    productIds,
    segment: document.getElementById('cmp-segment').value,
    scheduleAt: document.getElementById('cmp-schedule').value || null,
    headerText: document.getElementById('cmp-header').value.trim() || null,
    bodyText: document.getElementById('cmp-body').value.trim() || null,
  };
}

async function createCampaign() {
  const body = getCmpBody();
  if (!body) return;
  try {
    await api('/api/restaurant/campaigns', { method: 'POST', body });
    toast(body.scheduleAt ? 'Campaign scheduled!' : 'Campaign created (draft)', 'ok');
    loadCampaigns();
  } catch (e) { toast(e.message, 'err'); }
}

async function createAndSendCampaign() {
  const body = getCmpBody();
  if (!body) return;
  body.scheduleAt = null; // send immediately
  try {
    const campaign = await api('/api/restaurant/campaigns', { method: 'POST', body });
    toast('Sending campaign…', 'nfo');
    const result = await api(`/api/restaurant/campaigns/${campaign.id}/send`, { method: 'POST' });
    toast(`Campaign sent: ${result.sent} delivered, ${result.failed} failed`, 'ok');
    loadCampaigns();
  } catch (e) { toast(e.message, 'err'); }
}

async function sendCampaignNow(id) {
  if (!confirm('Send this campaign now?')) return;
  try {
    toast('Sending…', 'nfo');
    const result = await api(`/api/restaurant/campaigns/${id}/send`, { method: 'POST' });
    toast(`Sent: ${result.sent} delivered, ${result.failed} failed`, 'ok');
    loadCampaigns();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteCampaignRow(id, name) {
  if (!confirm(`Delete campaign "${name}"?`)) return;
  try {
    await api(`/api/restaurant/campaigns/${id}`, { method: 'DELETE' });
    toast('Campaign deleted', 'ok');
    loadCampaigns();
  } catch (e) { toast(e.message, 'err'); }
}

// [WhatsApp2026] Pause/Resume campaign
async function pauseCampaignNow(id) {
  if (!confirm('Pause this campaign? Remaining messages will stop sending.')) return;
  try {
    await api(`/api/restaurant/campaigns/${id}/pause`, { method: 'POST' });
    toast('Campaign paused', 'ok');
    loadCampaigns();
  } catch (e) { toast(e.message, 'err'); }
}

async function resumeCampaignNow(id) {
  if (!confirm('Resume this campaign? Sending will continue from where it stopped.')) return;
  try {
    await api(`/api/restaurant/campaigns/${id}/resume`, { method: 'POST' });
    toast('Campaign resumed — sending in background', 'ok');
    loadCampaigns();
  } catch (e) { toast(e.message, 'err'); }
}


// Expose to window
window.debounceCustSearch = debounceCustSearch;
window.loadCustomers = loadCustomers;
window.toggleCustHistory = toggleCustHistory;
window.showCustOrderHistory = showCustOrderHistory;
window.loadRatings = loadRatings;
window.applyPermissions = applyPermissions;
window.doPinLogin = doPinLogin;
window.loadTeam = loadTeam;
window.openAddUserModal = openAddUserModal;
window.closeUserModal = closeUserModal;
window.loadLoyalty = loadLoyalty;
window.loadReferrals = loadReferrals;
window.toggleCouponTypeFields = toggleCouponTypeFields;
window.loadCoupons = loadCoupons;
window.createCoupon = createCoupon;
window.toggleCoupon = toggleCoupon;
window.deleteCoupon = deleteCoupon;
window.loadCampaigns = loadCampaigns;
window.loadCampaignProducts = loadCampaignProducts;
window.updateCmpCount = updateCmpCount;
window.getCmpBody = getCmpBody;
window.createCampaign = createCampaign;
window.createAndSendCampaign = createAndSendCampaign;
window.sendCampaignNow = sendCampaignNow;
window.deleteCampaignRow = deleteCampaignRow;
window.pauseCampaignNow = pauseCampaignNow;
window.resumeCampaignNow = resumeCampaignNow;
window.loadRestaurantProfile = loadRestaurantProfile;
window.doSaveUser = doSaveUser;
window.editUser = editUser;
window.resetUserPin = resetUserPin;
window.toggleUser = toggleUser;

})();
