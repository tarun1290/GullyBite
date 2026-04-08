// frontend/js/tabs/settings.js
// Dashboard tab: Settings (Profile, WhatsApp, Integrations, Catalog Mgmt, Sync Logs, Feed)

(function() {

async function loadSyncLogs() {
  const tbody = document.getElementById('sync-log-tbody');
  try {
    const logs = await api('/api/restaurant/sync-logs');
    if (!logs?.length) { tbody.innerHTML = '<tr><td colspan="4" style="padding:1rem;text-align:center;color:var(--dim)">No sync activity yet</td></tr>'; return; }
    const sevIcon = { info: '✅', warning: '⚠️', error: '❌', critical: '🔴' };
    tbody.innerHTML = logs.map(l => `<tr style="border-bottom:1px solid var(--rim)">
      <td style="padding:.4rem .6rem;font-size:.76rem;color:var(--dim);white-space:nowrap">${new Date(l.created_at).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}</td>
      <td style="padding:.4rem .6rem;font-size:.8rem;font-weight:500">${l.action}</td>
      <td style="padding:.4rem .6rem;font-size:.78rem;color:var(--dim);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.description || '—'}</td>
      <td style="padding:.4rem .6rem;text-align:center">${sevIcon[l.severity] || '—'}</td>
    </tr>`).join('');
  } catch { tbody.innerHTML = '<tr><td colspan="4" style="padding:1rem;text-align:center;color:var(--dim)">Failed to load</td></tr>'; }
}

async function loadWA() {
  const list = document.getElementById('wa-list');
  try {
    const accounts = await api('/api/restaurant/whatsapp');
    // Filter out Meta test numbers and sandbox accounts
    const realAccounts = (accounts || []).filter(a => {
      const phone = (a.phone_display || a.wa_phone_number || '').replace(/\s/g, '');
      if (phone.startsWith('+1555') || phone.startsWith('1555') || phone.startsWith('+15550')) return false;
      if (a.account_mode === 'SANDBOX') return false;
      return true;
    });
    if (!realAccounts.length) {
      list.innerHTML = `<div class="empty"><div class="ei">📱</div><h3>No numbers found</h3><p>Try reconnecting your Meta account</p></div>`;
      return;
    }
    document.getElementById('live-dot').style.display = 'flex';
    list.innerHTML = realAccounts.map(a => {
      const registered = !!a.phone_registered;
      const hasCatalog = !!a.catalog_id;
      const cartOn     = !!a.cart_enabled;
      const allDone    = registered && hasCatalog && cartOn;

      const pill = (ok, label) => ok
        ? `<span style="display:inline-flex;align-items:center;gap:.25rem;font-size:.72rem;font-weight:600;color:#15803d;background:#dcfce7;padding:.18rem .5rem;border-radius:99px">${label}</span>`
        : `<span style="display:inline-flex;align-items:center;gap:.25rem;font-size:.72rem;font-weight:600;color:#92400e;background:#fef3c7;padding:.18rem .5rem;border-radius:99px">${label}</span>`;

      const checklist = `
        <div style="margin-top:.85rem;padding:.75rem;background:#f8fafc;border-radius:.5rem;border:1px solid var(--rim)">
          <div style="font-size:.72rem;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.5rem">Setup Checklist</div>
          <div style="display:flex;flex-direction:column;gap:.35rem">
            <div style="display:flex;align-items:center;gap:.5rem;font-size:.8rem">
              <span style="color:${registered ? '#15803d' : '#dc2626'};font-size:1rem">${registered ? '✅' : '⭕'}</span>
              <span style="${registered ? 'color:#15803d' : ''}">Phone number registered with Cloud API</span>
            </div>
            <div style="display:flex;align-items:center;gap:.5rem;font-size:.8rem">
              <span style="color:${hasCatalog ? '#15803d' : '#dc2626'};font-size:1rem">${hasCatalog ? '✅' : '⭕'}</span>
              <span style="${hasCatalog ? 'color:#15803d' : ''}">Catalog created &amp; linked to WABA</span>
            </div>
            <div style="display:flex;align-items:center;gap:.5rem;font-size:.8rem">
              <span style="color:${cartOn ? '#15803d' : '#dc2626'};font-size:1rem">${cartOn ? '✅' : '⭕'}</span>
              <span style="${cartOn ? 'color:#15803d' : ''}">Cart icon enabled on phone number</span>
            </div>
          </div>
          ${!allDone ? `<button class="btn-g btn-sm" style="font-size:.75rem;margin-top:.7rem;width:100%;justify-content:center" onclick="completeSetup('${a.id}',this)">
            ▶ Complete Setup Now
          </button>` : `<p style="font-size:.75rem;color:#15803d;margin-top:.5rem;font-weight:600">✅ Fully set up — ready for Meta approval</p>`}
        </div>`;

      return `<div class="card" style="margin-bottom:.85rem">
        <div class="ch">
          <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
            <strong>${a.display_name || 'WhatsApp Number'}</strong>
            <span class="badge ${a.is_active ? 'bg' : 'br'}">${a.is_active ? 'Active' : 'Inactive'}</span>
            ${pill(registered, registered ? '📱 Registered' : '⚠️ Not Registered')}
            ${pill(hasCatalog, hasCatalog  ? '✅ Catalog'    : '⚠️ No Catalog')}
            ${pill(cartOn,     cartOn      ? '🛒 Cart On'    : '⚠️ Cart Off')}
          </div>
          <span style="font-size:.75rem;color:var(--dim)">Quality: <strong style="color:${a.quality_rating === 'GREEN' ? '#15803d' : a.quality_rating === 'RED' ? 'var(--red)' : 'var(--gold2)'}">${a.quality_rating || '—'}</strong></span>
        </div>
        <div class="cb">
          <div class="ipair-row">
            <div class="ipair"><label>Phone Number</label><code>${a.phone_display || '—'}</code></div>
          </div>
          <!-- Technical IDs hidden — visible in admin dashboard -->
          <div class="ipair-row" style="display:none">
            <div class="ipair"><label>Phone Number ID</label><code>${a.phone_number_id}</code></div>
            <div class="ipair"><label>WABA ID</label><code>${a.waba_id || '—'}</code></div>
            <div class="ipair"><label>Catalog ID</label><code>${a.catalog_id || '—'}</code></div>
          </div>
          ${checklist}
        </div>
        <!-- Username + messaging sections hidden — managed by platform admins -->
        <div id="wa-username-section-${a._id || a.id}" style="display:none"></div>
        <div id="wa-messaging-section-${a._id || a.id}" style="display:none"></div>
      </div>`;
    }).join('');
  } catch (_) {}
  loadTemplateMappings();
  loadFeedStatus();
  loadUsernameStatus();
  loadMessagingStatus();
  loadMessagingAnalytics();
}

// [WhatsApp2026] Load username status for this restaurant
async function loadUsernameStatus() {
  try {
    const data = await api('/api/restaurant/username');
    // Find the first WA account section to inject into
    const sections = document.querySelectorAll('[id^="wa-username-section-"]');
    sections.forEach(section => {
      if (!data || data.username_status === 'not_claimed') {
        section.innerHTML = `
          <div style="display:flex;align-items:center;gap:.6rem">
            <span style="font-size:1.2rem">@</span>
            <div>
              <div style="font-size:.85rem;font-weight:600">WhatsApp Business Username</div>
              <p style="font-size:.78rem;color:var(--dim);margin-top:.15rem">Claim a @username to make your business searchable on WhatsApp. Contact GullyBite support to set it up.</p>
            </div>
          </div>`;
      } else if (data.username_status === 'active') {
        section.innerHTML = `
          <div style="display:flex;align-items:center;gap:.6rem">
            <span style="font-size:1.2rem;background:#dcfce7;padding:.3rem .5rem;border-radius:6px">@</span>
            <div style="flex:1">
              <div style="font-size:.85rem;font-weight:600">@${esc(data.business_username)} <span style="color:#22c55e;font-size:.75rem">Active</span></div>
              <div style="display:flex;align-items:center;gap:.5rem;margin-top:.3rem">
                <code style="font-size:.78rem;background:var(--ink2);padding:.2rem .5rem;border-radius:4px;border:1px solid var(--rim)">wa.me/${data.business_username}</code>
                <button class="btn-g btn-sm" onclick="navigator.clipboard.writeText('https://wa.me/${data.business_username}');toast('Link copied!','ok')" style="font-size:.72rem">Copy Link</button>
                <button class="btn-g btn-sm" onclick="navigator.clipboard.writeText('Message us on WhatsApp: @${data.business_username}');toast('Copied!','ok')" style="font-size:.72rem">Share Text</button>
              </div>
            </div>
          </div>`;
      } else if (data.username_status === 'pending_claim' || data.username_status === 'suggested') {
        const suggestion = data.business_username || (data.username_suggestions?.[0]);
        section.innerHTML = `
          <div style="display:flex;align-items:center;gap:.6rem">
            <span style="font-size:1.2rem;background:#fef9c3;padding:.3rem .5rem;border-radius:6px">@</span>
            <div>
              <div style="font-size:.85rem;font-weight:600">Suggested Username: @${esc(suggestion || '?')} <span style="color:#eab308;font-size:.75rem">${data.username_status.replace('_', ' ')}</span></div>
              <p style="font-size:.78rem;color:var(--dim);margin-top:.15rem">Contact GullyBite admin to finalize your username claim.</p>
            </div>
          </div>`;
      }
    });
  } catch (_) {}
}

// [WhatsApp2026] Load messaging limit / verification status
async function loadMessagingStatus() {
  try {
    const data = await api('/api/restaurant/messaging-status');
    const sections = document.querySelectorAll('[id^="wa-messaging-section-"]');
    sections.forEach(section => {
      const tier = data.messaging_limit_tier;
      const tierLabel = tier === 'TIER_100K' ? '100K/day' : tier === 'TIER_10K' ? '10K/day' : tier === 'TIER_2K' ? '2K/day' : tier === 'TIER_1K' ? '1K/day' : tier || '—';
      const isMax = tier === 'TIER_100K' || tier === 'UNLIMITED';
      const verStatus = data.business_verification_status || 'not_started';
      const verColor = verStatus === 'verified' ? '#22c55e' : verStatus === 'pending' ? '#eab308' : '#94a3b8';

      section.innerHTML = `
        <div style="display:flex;align-items:center;gap:1.2rem;flex-wrap:wrap">
          <div>
            <div style="font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.03em;margin-bottom:.15rem">Daily Messaging Limit</div>
            <div style="font-size:1rem;font-weight:700;color:${isMax ? '#22c55e' : 'var(--tx)'}">${tierLabel} ${isMax ? '<span style="font-size:.75rem;background:#dcfce7;padding:.15rem .4rem;border-radius:6px;color:#15803d;font-weight:600">Fully Unlocked</span>' : ''}</div>
            ${!isMax ? '<p style="font-size:.72rem;color:var(--dim);margin-top:.15rem">Complete Business Verification to unlock 100K messages/day</p>' : ''}
          </div>
          <div>
            <div style="font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.03em;margin-bottom:.15rem">Business Verification</div>
            <span style="display:inline-block;padding:.2rem .5rem;border-radius:8px;font-size:.78rem;font-weight:600;background:${verColor}20;color:${verColor}">${verStatus.replace('_', ' ')}</span>
          </div>
        </div>`;
    });
  } catch (_) {}
}

// [WhatsApp2026] Load messaging analytics — stats, costs, and account health
async function loadMessagingAnalytics() {
  try {
    const [stats, costs, health] = await Promise.all([
      api('/api/restaurant/messaging/stats').catch(() => null),
      api('/api/restaurant/messaging/costs').catch(() => null),
      api('/api/restaurant/messaging/health').catch(() => null),
    ]);

    const sections = document.querySelectorAll('[id^="wa-messaging-section-"]');
    sections.forEach(section => {
      // Append analytics below existing messaging status
      let html = section.innerHTML;

      // Message delivery stats
      if (stats && stats.total > 0) {
        const deliveryRate = stats.total > 0 ? ((stats.delivered + stats.read) / stats.total * 100).toFixed(1) : '0';
        const readRate = stats.total > 0 ? (stats.read / stats.total * 100).toFixed(1) : '0';
        html += `
          <div style="margin-top:.8rem;padding-top:.8rem;border-top:1px solid var(--rim)">
            <div style="font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.03em;margin-bottom:.5rem">Message Analytics (All Time)</div>
            <div style="display:flex;gap:1rem;flex-wrap:wrap">
              <div style="text-align:center"><div style="font-size:1.1rem;font-weight:700">${stats.total}</div><div style="font-size:.7rem;color:var(--dim)">Total Sent</div></div>
              <div style="text-align:center"><div style="font-size:1.1rem;font-weight:700;color:#22c55e">${deliveryRate}%</div><div style="font-size:.7rem;color:var(--dim)">Delivered</div></div>
              <div style="text-align:center"><div style="font-size:1.1rem;font-weight:700;color:#2563eb">${readRate}%</div><div style="font-size:.7rem;color:var(--dim)">Read</div></div>
              <div style="text-align:center"><div style="font-size:1.1rem;font-weight:700;color:#dc2626">${stats.failed}</div><div style="font-size:.7rem;color:var(--dim)">Failed</div></div>
            </div>
          </div>`;
      }

      // Cost breakdown
      if (costs && costs.breakdown?.length) {
        const totalCost = costs.breakdown.reduce((s, b) => s + b.cost_rs, 0);
        html += `
          <div style="margin-top:.6rem;padding-top:.6rem;border-top:1px solid var(--rim)">
            <div style="font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.03em;margin-bottom:.4rem">Estimated Messaging Costs</div>
            <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:baseline">
              <div style="font-size:1.1rem;font-weight:700">₹${totalCost.toFixed(2)}</div>
              <div style="font-size:.72rem;color:var(--dim)">${costs.breakdown.map(b => `${b.category}: ₹${b.cost_rs.toFixed(2)} (${b.count})`).join(' · ')}</div>
            </div>
          </div>`;
      }

      // Account health
      if (health && health.latest) {
        const h = health.latest;
        const qColor = h.quality_rating === 'GREEN' ? '#22c55e' : h.quality_rating === 'YELLOW' ? '#eab308' : h.quality_rating === 'RED' ? '#dc2626' : '#94a3b8';
        html += `
          <div style="margin-top:.6rem;padding-top:.6rem;border-top:1px solid var(--rim)">
            <div style="font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.03em;margin-bottom:.4rem">Account Quality</div>
            <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap">
              <span style="display:inline-block;padding:.2rem .5rem;border-radius:8px;font-size:.78rem;font-weight:600;background:${qColor}20;color:${qColor}">${h.quality_rating || 'Unknown'}</span>
              <span style="font-size:.72rem;color:var(--dim)">Checked: ${new Date(h.checked_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              <button class="btn-g btn-sm" onclick="checkAccountHealth()" style="font-size:.68rem">Refresh</button>
            </div>
            ${h.quality_rating === 'RED' || h.quality_rating === 'LOW' || h.quality_rating === 'FLAGGED' ?
              '<p style="font-size:.72rem;color:#dc2626;margin-top:.3rem">⚠️ Quality is degraded. Reduce template message volume and check customer feedback.</p>' : ''}
          </div>`;
      }

      section.innerHTML = html;
    });
  } catch (_) {}
}

async function checkAccountHealth() {
  try {
    const result = await api('/api/restaurant/messaging/health/check', { method: 'POST' });
    toast(`Quality: ${result.quality_rating || 'Unknown'}, Limit: ${result.messaging_limit || 'Unknown'}`, 'ok');
    loadMessagingAnalytics();
  } catch (e) {
    toast(e.message || 'Failed to check health', 'err');
  }
}

async function completeSetup(waAccountId, btn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:.4rem"><span style="width:12px;height:12px;border:2px solid rgba(0,0,0,.2);border-top-color:#333;border-radius:50%;animation:spin .7s linear infinite;display:inline-block"></span> Running setup…</span>';
  try {
    const d = await api(`/api/restaurant/whatsapp/${waAccountId}/complete-setup`, { method: 'POST' });
    const ok = d.phone_registered && d.cart_enabled && d.catalog_id;
    if (ok) {
      toast('All setup steps complete — ready for Meta approval!', 'ok');
    } else {
      const failed = Object.entries(d.steps || {}).filter(([,v]) => v !== 'ok').map(([k,v]) => `${k}: ${v}`);
      toast(`Partial setup — ${failed.join('; ')}`, 'nfo');
    }
    loadWA();
  } catch (e) {
    toast(e.message || 'Setup failed — please try again', 'err');
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function provisionCatalog(waAccountId, btn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:.4rem"><span style="width:12px;height:12px;border:2px solid rgba(0,0,0,.2);border-top-color:#333;border-radius:50%;animation:spin .7s linear infinite;display:inline-block"></span> Setting up…</span>';
  try {
    await api(`/api/restaurant/whatsapp/${waAccountId}/provision-catalog`, { method: 'POST' });
    toast('Catalog linked & cart icon enabled!', 'ok');
    loadWA();
  } catch (e) {
    toast(e.message || 'Setup failed — please try again', 'err');
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function copyWH() { navigator.clipboard.writeText(document.getElementById('wh-url').textContent).then(() => toast('Webhook URL copied!', 'ok')); }


let waTemplates    = [];
let templateMappings = {}; // keyed by event name

const EVENT_META = {
  CONFIRMED : { label: '✅ Order Confirmed',  color: '#22c55e' },
  PREPARING : { label: '👨‍🍳 Preparing',       color: '#f59e0b' },
  PACKED    : { label: '📦 Packed & Ready',   color: '#3b82f6' },
  DISPATCHED: { label: '🚴 Out for Delivery', color: '#8b5cf6' },
  DELIVERED : { label: '🎉 Delivered',        color: '#10b981' },
  CANCELLED : { label: '❌ Cancelled',        color: '#ef4444' },
};

const VAR_FIELDS = [
  { value: '',                label: '— select field —' },
  { value: 'order_number',    label: 'Order number  (#1234)' },
  { value: 'customer_name',   label: 'Customer name' },
  { value: 'total_rs',        label: 'Total amount  (₹)' },
  { value: 'branch_name',     label: 'Branch / outlet name' },
  { value: 'restaurant_name', label: 'Restaurant brand name' },
  { value: 'eta',             label: 'Estimated delivery time' },
  { value: 'tracking_url',    label: 'Delivery tracking link' },
];

async function loadWATemplates() {
  const btn = document.getElementById('tmpl-refresh-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Loading…';
  try {
    waTemplates = await api('/api/restaurant/whatsapp/templates');
    renderTemplateTable();
    renderEventMappings();
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('pending_approval') || msg.includes('No active WhatsApp')) {
      const tbody = document.getElementById('tmpl-tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:1.5rem;text-align:center;color:#92400e;background:#fffbeb">⏳ WhatsApp Business not yet approved by Meta. Templates will appear here once your account is approved.</td></tr>';
    } else {
      toast(msg || 'Failed to load templates', 'err');
    }
  }
  finally { btn.disabled = false; btn.innerHTML = '🔄 Refresh from Meta'; }
}

function renderTemplateTable() {
  const tbody = document.getElementById('tmpl-tbody');
  if (!waTemplates.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="padding:1.5rem;text-align:center;color:var(--dim)">No templates found. Create and submit templates for approval in Meta Business Manager.</td></tr>';
    return;
  }
  const sc = { APPROVED:'#22c55e', PENDING:'#f59e0b', REJECTED:'#ef4444', PAUSED:'#6b7280' };
  tbody.innerHTML = waTemplates.map(t => {
    const body = t.components?.find(c => c.type === 'BODY')?.text || '—';
    const preview = body.length > 90 ? body.substring(0, 90) + '…' : body;
    return `<tr style="border-bottom:1px solid var(--rim)">
      <td style="padding:.6rem 1rem;font-family:monospace;font-size:.8rem;font-weight:600">${t.name}</td>
      <td style="padding:.6rem 1rem;font-size:.78rem">${t.category || '—'}</td>
      <td style="padding:.6rem 1rem"><span style="font-size:.76rem;font-weight:600;color:${sc[t.status]||'#6b7280'}">${t.status}</span></td>
      <td style="padding:.6rem 1rem;font-size:.78rem;color:var(--dim)">${t.language}</td>
      <td style="padding:.6rem 1rem;font-size:.76rem;color:var(--dim);max-width:260px;word-break:break-word">${preview}</td>
    </tr>`;
  }).join('');
}

async function loadTemplateMappings() {
  try {
    const [rows, defaults] = await Promise.all([
      api('/api/restaurant/whatsapp/template-mappings'),
      api('/api/restaurant/whatsapp/template-defaults').catch(() => []),
    ]);
    templateMappings = {};
    (rows || []).forEach(r => {
      templateMappings[r.event_name] = {
        template_name    : r.template_name,
        template_language: r.template_language,
        variable_map     : r.variable_map || {},
      };
    });
    // Show global defaults info
    const infoBox = document.getElementById('global-tpl-info');
    const listEl = document.getElementById('global-tpl-list');
    if (defaults?.length) {
      infoBox.style.display = 'block';
      listEl.innerHTML = defaults.map(d =>
        `<span style="background:rgba(79,70,229,.08);color:var(--acc);padding:.15rem .45rem;border-radius:4px;font-size:.75rem">${d.event} → ${d.template_name}</span>`
      ).join('');
    } else {
      infoBox.style.display = 'none';
    }
    if (waTemplates.length) renderEventMappings();
  } catch (_) {}
}

function renderEventMappings() {
  const container = document.getElementById('event-mappings');
  const approved = waTemplates.filter(t => t.status === 'APPROVED');

  container.innerHTML = Object.entries(EVENT_META).map(([event, meta]) => {
    const saved   = templateMappings[event] || {};
    const tmplName = saved.template_name || '';
    const varMap   = saved.variable_map  || {};

    const opts = [
      `<option value="">— plain text fallback —</option>`,
      ...approved.map(t => `<option value="${t.name}" ${t.name === tmplName ? 'selected' : ''}>${t.name} (${t.language})</option>`),
    ].join('');

    // Parse body variables from selected template
    const sel = waTemplates.find(t => t.name === tmplName);
    const bodyText = sel?.components?.find(c => c.type === 'BODY')?.text || '';
    const slots = [...new Set([...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1]))].sort((a, b) => +a - +b);

    const varHtml = slots.length ? `
      <div style="margin-top:.55rem;padding:.6rem .8rem;background:var(--ink2);border-radius:7px">
        <div style="font-size:.72rem;color:var(--dim);margin-bottom:.4rem">Map variables → order data:</div>
        ${slots.map(s => `
          <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.3rem">
            <code style="background:var(--ink3);padding:.1rem .38rem;border-radius:4px;min-width:2.6rem;text-align:center;font-size:.76rem">{{${s}}}</code>
            <select class="inp" style="padding:.24rem .5rem;font-size:.76rem;flex:1" onchange="setVarMap('${event}','${s}',this.value)">
              ${VAR_FIELDS.map(f => `<option value="${f.value}" ${(varMap[s]||'') === f.value ? 'selected' : ''}>${f.label}</option>`).join('')}
            </select>
          </div>`).join('')}
      </div>` : '';

    const clearBtn = tmplName
      ? `<button class="btn-g btn-sm" style="font-size:.74rem;padding:.22rem .55rem;margin-top:.4rem" onclick="clearEventTemplate('${event}')">✕ Clear</button>`
      : '';

    return `<div style="display:flex;align-items:flex-start;gap:1rem;padding:.85rem 0;border-bottom:1px solid var(--rim)">
      <div style="min-width:170px;font-size:.82rem;font-weight:600;color:${meta.color};padding-top:.35rem">${meta.label}</div>
      <div style="flex:1">
        <select class="inp" style="font-size:.82rem" onchange="onEventTemplateChange('${event}',this.value)">
          ${opts}
        </select>
        ${varHtml}
        ${clearBtn}
      </div>
    </div>`;
  }).join('');
}

function onEventTemplateChange(event, tmplName) {
  const tmpl = waTemplates.find(t => t.name === tmplName);
  if (!tmpl) { delete templateMappings[event]; renderEventMappings(); return; }
  templateMappings[event] = {
    template_name    : tmplName,
    template_language: tmpl.language || 'en',
    variable_map     : {},
  };
  renderEventMappings();
}

function setVarMap(event, slot, field) {
  if (!templateMappings[event]) templateMappings[event] = { variable_map: {} };
  if (!templateMappings[event].variable_map) templateMappings[event].variable_map = {};
  templateMappings[event].variable_map[slot] = field;
}

function clearEventTemplate(event) {
  delete templateMappings[event];
  renderEventMappings();
}

async function saveTemplateMappings() {
  const btn = document.getElementById('tmpl-save-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Saving…';
  try {
    const body = Object.entries(templateMappings)
      .filter(([, v]) => v.template_name)
      .map(([eventName, v]) => ({
        eventName,
        templateName    : v.template_name,
        templateLanguage: v.template_language || 'en',
        variableMap     : v.variable_map || {},
      }));
    await api('/api/restaurant/whatsapp/template-mappings', { method: 'PUT', body });
    toast('Template mappings saved!', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '💾 Save Mappings'; }
}


async function loadProfile() {
  try {
    const r = await api('/auth/me'); if (!r) return;
    const map = {
      'p-bname':    'business_name',
      'p-legalname':'registered_business_name',
      'p-owner':    'owner_name',
      'p-phone':    'phone',
      'p-email':    'email',
      'p-city':     'city',
      'p-logo':     'logo_url',
      'p-gst':      'gst_number',
      'p-fssai':    'fssai_license',
      'p-bank':     'bank_name',
      'p-accno':    'bank_account_number',
      'p-ifsc':     'bank_ifsc',
    };
    Object.entries(map).forEach(([id, k]) => {
      const e = document.getElementById(id); if (e) e.value = r[k] || '';
    });
    // Date field
    const expEl = document.getElementById('p-fssai-exp');
    if (expEl && r.fssai_expiry) expEl.value = r.fssai_expiry.split('T')[0];
    // Select field
    const rtEl = document.getElementById('p-rtype');
    if (rtEl && r.restaurant_type) rtEl.value = r.restaurant_type;

    // Pricing & charge config
    const gstModeEl = document.getElementById('p-gst-mode');
    if (gstModeEl && r.menu_gst_mode) { gstModeEl.value = r.menu_gst_mode; toggleDashGstHint(r.menu_gst_mode); }
    const delPctEl = document.getElementById('p-del-pct');
    if (delPctEl && r.delivery_fee_customer_pct != null) { delPctEl.value = r.delivery_fee_customer_pct; updateDashDeliveryHint(r.delivery_fee_customer_pct); }
    const pkgEl = document.getElementById('p-pkg-charge');
    if (pkgEl && r.packaging_charge_rs != null) pkgEl.value = r.packaging_charge_rs;
    const pkgGstEl = document.getElementById('p-pkg-gst');
    if (pkgGstEl && r.packaging_gst_pct != null) pkgGstEl.value = r.packaging_gst_pct;

    // Store URL — split into base + editable slug
    const storeUrlEl = document.getElementById('p-store-url');
    const storeBaseEl = document.getElementById('p-store-base');
    const storeSlugEl = document.getElementById('p-store-slug');
    if (storeUrlEl && r.store_url) storeUrlEl.value = r.store_url;
    if (storeBaseEl) {
      const baseUrl = (r.store_url || '').replace(/\/store\/.*$/, '/store/');
      storeBaseEl.textContent = baseUrl || `${location.origin}/store/`;
    }
    if (storeSlugEl && r.store_slug) storeSlugEl.value = r.store_slug;
    // Set placeholder to a slug version of the restaurant name
    if (storeSlugEl && !storeSlugEl.value) {
      const suggestedSlug = (r.business_name || r.brand_name || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').substring(0, 40);
      if (suggestedSlug) storeSlugEl.placeholder = suggestedSlug;
    }

    // GST / FSSAI verification badges
    const gstBadge   = document.getElementById('gst-badge');
    const fssaiBadge = document.getElementById('fssai-badge');
    if (gstBadge)   gstBadge.style.display   = r.gst_verified   ? '' : 'none';
    if (fssaiBadge) fssaiBadge.style.display  = r.fssai_verified ? '' : 'none';

    // GST/FSSAI caution — conditional on approval status
    const gstCaution = document.getElementById('gst-fssai-caution');
    if (gstCaution) {
      const isApproved = rest?.approval_status === 'approved';
      gstCaution.style.display = 'block';
      if (isApproved) {
        gstCaution.style.background = '#f0fdf4';
        gstCaution.style.borderColor = '#bbf7d0';
        gstCaution.style.color = '#15803d';
        gstCaution.textContent = '\u2705 Restaurant approved \u2014 GST and FSSAI details verified.';
      }
    }

    // Notification settings
    const notifyPhonesEl = document.getElementById('p-notify-phones');
    if (notifyPhonesEl && r.notification_phones) notifyPhonesEl.value = r.notification_phones.join(', ');
    const ns = r.notification_settings || {};
    const setChk = (id, val, def = true) => { const el = document.getElementById(id); if (el) el.checked = val !== undefined ? val : def; };
    setChk('p-notify-new-order', ns.new_order);
    setChk('p-notify-payment', ns.payment);
    setChk('p-notify-cancelled', ns.cancelled);
    setChk('p-notify-low-activity', ns.low_activity, false);

    // Populate view-mode displays (read-only summaries)
    var bizView = document.getElementById('sec-biz-view');
    if (bizView) bizView.innerHTML = renderBizView(r);
    var pricingView = document.getElementById('sec-pricing-view');
    if (pricingView) pricingView.innerHTML = renderPricingView(r);
    var notifyView = document.getElementById('sec-notify-view');
    if (notifyView) notifyView.innerHTML = renderNotifyView(r);

    // WhatsApp connection status — check whatsapp_connected flag (derived from meta_user_id + waba_accounts on backend)
    const waAccounts = r.waba_accounts || [];
    const hasWA = !!(r.whatsapp_connected || r.meta_user_id || waAccounts.length > 0);
    const dot   = document.getElementById('wa-status-dot');
    const lbl   = document.getElementById('wa-status-label');
    const sub   = document.getElementById('wa-status-sub');
    const wrap  = document.getElementById('wa-reconnect-wrap');
    if (hasWA) {
      dot.style.background  = '#22c55e';
      lbl.textContent       = 'Connected';
      sub.textContent       = waAccounts.length
        ? waAccounts.map(a => a.name || a.waba_id).join(', ')
        : 'WhatsApp Business account linked';
      wrap.style.display    = 'none';
    } else {
      dot.style.background  = '#ef4444';
      lbl.textContent       = 'Not connected';
      sub.textContent       = 'Connect your WhatsApp Business account to start receiving orders';
      wrap.style.display    = 'block';
    }
  } catch (_) {}
}

function copyDashStoreUrl() {
  const base = document.getElementById('p-store-base')?.textContent || '';
  const slug = document.getElementById('p-store-slug')?.value || '';
  const url = base + slug;
  if (url) navigator.clipboard.writeText(url).then(() => toast('Store URL copied!', 'ok'));
}

async function doUpdateSlug() {
  const slugEl = document.getElementById('p-store-slug');
  let slug = (slugEl?.value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) { toast('Slug cannot be empty', 'err'); return; }
  slugEl.value = slug; // show cleaned version
  try {
    const r = await api('/api/restaurant/update-slug', { method: 'POST', body: { slug } });
    if (r?.store_url) {
      document.getElementById('p-store-url').value = r.store_url;
      toast('Store URL updated!', 'ok');
    }
  } catch (e) { toast(e.message || 'Failed to update slug', 'err'); }
}

async function doSaveProfile() {
  try {
    await api('/api/restaurant', { method: 'PUT', body: {
      businessName:           document.getElementById('p-bname').value,
      registeredBusinessName: document.getElementById('p-legalname').value,
      ownerName:              document.getElementById('p-owner').value,
      phone:                  document.getElementById('p-phone').value,
      city:                   document.getElementById('p-city').value,
      restaurantType:         document.getElementById('p-rtype').value,
      logoUrl:                document.getElementById('p-logo').value,
      gstNumber:              document.getElementById('p-gst').value,
      fssaiLicense:           document.getElementById('p-fssai').value,
      fssaiExpiry:            document.getElementById('p-fssai-exp').value || null,
      bankName:               document.getElementById('p-bank').value,
      bankAccountNumber:      document.getElementById('p-accno').value,
      bankIfsc:               document.getElementById('p-ifsc').value,
    }});
    toast('Profile saved', 'ok');
    const nm = document.getElementById('p-bname').value;
    if (nm) document.getElementById('sb-nm').textContent = nm;
  } catch (e) { toast(e.message, 'err'); }
}

async function doSaveNotifySettings() {
  try {
    const phonesRaw = document.getElementById('p-notify-phones').value;
    const notificationPhones = phonesRaw.split(',').map(p => p.trim()).filter(Boolean);
    const notificationSettings = {
      new_order:    document.getElementById('p-notify-new-order').checked,
      payment:      document.getElementById('p-notify-payment').checked,
      cancelled:    document.getElementById('p-notify-cancelled').checked,
      low_activity: document.getElementById('p-notify-low-activity').checked,
    };
    await api('/api/restaurant', { method: 'PUT', body: { notificationPhones, notificationSettings } });
    toast('Notification settings saved', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

function toggleDashGstHint(v) {
  const el = document.getElementById('p-gst-mode-hint');
  if (el) el.style.display = v === 'extra' ? '' : 'none';
}
function updateDashDeliveryHint(v) {
  const pct  = Math.min(100, Math.max(0, parseInt(v, 10) || 0));
  const rest = 100 - pct;
  const el   = document.getElementById('p-del-pct-hint');
  if (el) el.innerHTML = `Customer pays <strong>${pct}%</strong> of the delivery fee. Your restaurant absorbs <strong>${rest}%</strong>.<br><span style="color:var(--mute)">Example: if delivery costs ₹40 and you set ${pct}%, customer pays ₹${(40 * pct / 100).toFixed(0)} and restaurant absorbs ₹${(40 * rest / 100).toFixed(0)}.</span>`;
}

async function doSaveChargeConfig() {
  try {
    await api('/api/restaurant', { method: 'PUT', body: {
      menuGstMode:            document.getElementById('p-gst-mode').value,
      deliveryFeeCustomerPct: parseInt(document.getElementById('p-del-pct').value, 10),
      packagingChargeRs:      parseFloat(document.getElementById('p-pkg-charge').value) || 0,
      packagingGstPct:        parseFloat(document.getElementById('p-pkg-gst').value),
    }});
    toast('Charge settings saved', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}



// Note: The detailed catalog UI moved to the cat-mgmt section in tab-whatsapp.
// This function now only fetches data for the gear-icon catalog panel on the Menu page.
async function loadCatalogStatus() {
  try {
    const [d, catData] = await Promise.all([
      api('/api/restaurant/catalog/status').catch(() => null),
      api('/api/restaurant/catalogs').catch(() => null),
    ]);

    // Store for use by catalog panel (gear icon on Menu page)
    window._catalogStatusData = d;
    window._catalogListData = catData;
  } catch (e) {
    console.warn('[Catalog] Status fetch failed:', e.message);
  }
}

async function toggleCatalogLink(checked) {
  const el = document.getElementById('toggle-catalog-linked');
  if (!checked) {
    if (!confirm('⚠️ Hide menu from WhatsApp?\n\nThis will hide your catalog from WhatsApp customers.\nYour menu items and catalog are NOT deleted.\nYou can re-enable anytime.')) {
      el.checked = true; return;
    }
  }
  el.disabled = true;
  try {
    await api(`/api/restaurant/catalog/${checked ? 'link' : 'unlink'}`, { method: 'POST' });
    toast(checked ? '✅ Catalog linked to WhatsApp' : '✅ Catalog hidden from WhatsApp', 'ok');
    loadCatalogStatus();
  } catch (e) {
    el.checked = !checked; // revert
    toast('❌ ' + (e.message || 'Failed'), 'err');
  } finally { el.disabled = false; }
}

async function toggleCatalogCart(checked) {
  const el = document.getElementById('toggle-cart-enabled');
  el.disabled = true;
  try {
    await api('/api/restaurant/catalog/cart-toggle', { method: 'POST', body: { enabled: checked } });
    toast(checked ? '✅ Cart enabled' : '✅ Cart disabled', 'ok');
  } catch (e) {
    el.checked = !checked;
    toast('❌ ' + (e.message || 'Failed'), 'err');
  } finally { el.disabled = false; }
}

async function toggleCatalogVisibility(checked) {
  const el = document.getElementById('toggle-catalog-visible');
  el.disabled = true;
  try {
    await api('/api/restaurant/catalog/visibility-toggle', { method: 'POST', body: { visible: checked } });
    toast(checked ? '✅ Catalog visible to customers' : '✅ Catalog hidden from profile', 'ok');
  } catch (e) {
    el.checked = !checked;
    toast('❌ ' + (e.message || 'Failed'), 'err');
  } finally { el.disabled = false; }
}

async function doChangeCatalog() {
  const select = document.getElementById('catalog-select');
  if (!select) return;
  const catalogId = select.value;
  const catalogName = select.options[select.selectedIndex]?.text || '';
  try {
    await api('/api/restaurant/catalog', { method: 'PUT', body: { catalog_id: catalogId, catalog_name: catalogName } });
    toast('Catalog updated!', 'ok');
    loadCatalogStatus();
  } catch (e) { toast(e.message || 'Failed to update catalog', 'err'); }
}

async function doCatalogSync() {
  const btn = document.getElementById('catalog-sync-btn');
  btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    const d = await api('/api/restaurant/catalog/sync', { method: 'POST' });
    if (d) {
      const total = d.results?.reduce((s, r) => s + (r.updated || 0), 0) || 0;
      const failed = d.results?.reduce((s, r) => s + (r.failed || 0), 0) || 0;
      toast(failed ? `Synced ${total} items, ${failed} failed` : `Synced ${total} items!`, failed ? 'err' : 'ok');
      loadCatalogStatus();
    }
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Sync All Items Now'; }
}

async function doCatalogCreate() {
  const btn = document.getElementById('catalog-create-btn');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    // Create catalog for first branch
    const branches = rest?.branches || [];
    if (!branches.length) {
      // Fetch branches
      const brData = await api('/api/restaurant/branches');
      if (brData && brData.length) {
        const result = await api(`/api/restaurant/branches/${brData[0]._id || brData[0].id}/create-catalog`, { method: 'POST' });
        if (result) toast(result.catalogId ? `Catalog created: ${result.catalogId}` : 'Catalog ready', 'ok');
        loadCatalogStatus();
      } else {
        toast('No branches found — add a branch first', 'err');
      }
    }
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Create Catalog'; }
}

async function doClearAndResync() {
  if (!confirm('⚠️ This will DELETE all items from your WhatsApp catalog and re-upload everything.\n\nCustomers won\'t see the catalog during sync (1-2 minutes).\n\nContinue?')) return;
  toast('Clearing catalog and re-syncing...', 'ok');
  try {
    const r = await api('/api/restaurant/catalog/clear-and-resync', { method: 'POST' });
    toast(`✅ Cleared ${r.deleted_from_meta} old items, synced ${r.totalSynced} fresh items`, 'ok');
    loadMenu();
    updateSyncStatus();
  } catch (e) { toast('❌ ' + (e.message || 'Clear & re-sync failed'), 'err'); }
}

async function doReverseCatalogSync() {
  if (!confirm('Import items from your Meta catalog into GullyBite?\n\nExisting items will be updated. No items will be deleted.')) return;
  try {
    toast('Importing items from catalog... ⏳', 'ok');
    const r = await api('/api/restaurant/catalog/reverse-sync', { method: 'POST' });
    if (r.success) {
      toast(`✅ Imported ${r.total_in_meta} items (${r.new_items_added} new, ${r.existing_items_updated} updated)`, 'ok');
      loadMenu();
    } else {
      toast('Import failed: ' + (r.error || 'Unknown error'), 'err');
    }
  } catch (e) { toast('Import failed: ' + e.message, 'err'); }
}

async function loadCollectionStatus() {
  const el = document.getElementById('collection-list');
  if (!el) return;
  try {
    const status = await api('/api/restaurant/collections/branch-status');
    if (!status?.length) { el.textContent = 'No branches yet'; return; }
    el.innerHTML = status.map(b =>
      `<div style="display:flex;align-items:center;gap:.4rem;padding:.3rem 0;border-bottom:1px solid var(--bdr)">
        <span style="flex:1">${b.name}</span>
        <span style="font-size:.75rem;color:var(--dim)">${b.product_count} items · ${b.product_set_count} sets</span>
        ${b.meta_collection_id
          ? `<span style="color:var(--wa);font-size:.78rem" title="${b.meta_collection_id}">✅ Synced</span>`
          : `<span style="color:var(--red);font-size:.78rem">❌ Missing</span>`}
      </div>`
    ).join('');
  } catch (e) { el.textContent = 'Failed to load'; }
}

async function doSyncBranchCollections() {
  try {
    toast('Syncing branch Collections...', 'ok');
    const r = await api('/api/restaurant/collections/sync-branch-collections', { method: 'POST' });
    toast(`Collections synced: ${r.created} created, ${r.updated} updated`, 'ok');
    loadCollectionStatus();
  } catch (e) { toast('Sync failed: ' + e.message, 'err'); }
}

async function toggleCatalogAutoSync(enabled) {
  try {
    await api('/api/restaurant/catalog/toggle-auto-sync', { method: 'POST', body: { enabled } });
    toast(enabled ? 'Auto-sync enabled' : 'Auto-sync disabled', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// ── Catalog Management (WhatsApp tab) ──────────────────────
let _catMgmtData = null;

async function loadCatalogMgmt(refresh = false) {
  var statusEl = document.getElementById('cat-mgmt-status');
  var listEl = document.getElementById('cat-mgmt-list');
  var settingsEl = document.getElementById('cat-mgmt-settings');
  var deleteConfirmEl = document.getElementById('cat-mgmt-delete-confirm');
  if (!statusEl) { toast('Catalog section not available — try refreshing the page', 'err'); return; }
  if (deleteConfirmEl) deleteConfirmEl.style.display = 'none';

  // Ensure rest is loaded — if null, fetch it now
  if (!rest) {
    try { rest = await api('/auth/me'); } catch (_) {}
    if (!rest) {
      statusEl.innerHTML = '<div style="padding:.8rem;font-size:.82rem;color:var(--red);background:#fef2f2;border:1px solid #fecaca;border-radius:8px">'
        + 'Could not load restaurant data. <button class="btn-g btn-sm" style="font-size:.72rem;margin-left:.5rem" onclick="loadCatalogMgmt()">Retry</button></div>';
      return;
    }
  }

  loadCatalogVisibility();

  // Helper: enable/disable a button (never display:none)
  function setBtnState(id, enabled) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '' : '.4';
    btn.style.cursor = enabled ? '' : 'not-allowed';
  }

  // ── PHASE 1: Render immediately from cached rest data (no API call) ──
  var cachedCatId = rest?.meta_catalog_id;
  var cachedCatName = rest?.meta_catalog_name || 'Menu Catalog';
  var isConnected = !!cachedCatId;

  if (isConnected) {
    statusEl.innerHTML = '<div style="display:flex;align-items:center;gap:.6rem;padding:.6rem .8rem;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15);border-radius:8px">'
      + '<span style="width:10px;height:10px;border-radius:50%;background:#22c55e;flex-shrink:0"></span>'
      + '<div style="flex:1"><div style="font-weight:600;font-size:.85rem">\uD83D\uDCE6 ' + cachedCatName + '</div>'
      + '<div style="font-size:.73rem;color:var(--dim)">ID: ' + cachedCatId + '</div></div>'
      + '<span class="badge bg" style="font-size:.68rem">Connected</span></div>';
  } else {
    statusEl.innerHTML = '<div style="display:flex;align-items:center;gap:.6rem;padding:.6rem .8rem;background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.15);border-radius:8px">'
      + '<span style="width:10px;height:10px;border-radius:50%;background:#dc2626;flex-shrink:0"></span>'
      + '<div><div style="font-weight:600;font-size:.85rem;color:#dc2626">No catalog connected</div>'
      + '<div style="font-size:.77rem;color:var(--dim)">Create a new catalog or connect an existing one below.</div></div></div>';
  }

  // Approval warning
  if (rest?.approval_status && rest.approval_status !== 'approved') {
    statusEl.innerHTML += '<div style="padding:.5rem .7rem;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;margin-top:.5rem;font-size:.78rem;color:#92400e">\u26A0\uFE0F Approval pending \u2014 some catalog actions require restaurant approval. Status: <strong>' + rest.approval_status + '</strong></div>';
  }

  // Set initial button states from cache
  setBtnState('cat-create-btn', true);
  setBtnState('cat-connect-btn', false);
  setBtnState('cat-disconnect-btn', isConnected);
  setBtnState('cat-delete-btn', isConnected);
  setBtnState('cat-diagnostics-btn', isConnected);
  setBtnState('cat-sync-btn', isConnected);
  if (settingsEl) settingsEl.style.display = isConnected ? 'block' : 'none';

  // Show loading in catalog list area
  if (listEl) listEl.innerHTML = '<div style="text-align:center;padding:.6rem;font-size:.78rem;color:var(--dim)"><div class="spin" style="margin:0 auto .3rem;width:16px;height:16px"></div>Loading catalogs from Meta...</div>';

  // ── PHASE 2: Async API call to get live catalog data ──
  try {
    var catData = await api('/api/restaurant/catalogs' + (refresh ? '?refresh=true' : ''));
    _catMgmtData = catData;
    var active = catData?.active_catalog_id;
    var allCatalogs = catData?.catalogs || [];
    var activeCat = allCatalogs.find(function(c) { return c.id === active; });

    // Update count badge
    var countTextEl = document.getElementById('wa-catalog-count-text');
    if (countTextEl) {
      countTextEl.textContent = allCatalogs.length ? allCatalogs.length + ' catalog' + (allCatalogs.length > 1 ? 's' : '') + ' connected' : 'No catalogs connected';
      countTextEl.style.color = allCatalogs.length ? 'var(--fg)' : 'var(--dim)';
    }

    // Render catalog list
    if (listEl) {
      if (allCatalogs.length) {
        listEl.innerHTML = allCatalogs.map(function(c) {
          var isActive = c.id === active || c.connected;
          return '<div style="display:flex;align-items:center;gap:.6rem;padding:.6rem .8rem;background:' + (isActive ? 'rgba(34,197,94,.06)' : 'var(--ink2)') + ';border:1px solid ' + (isActive ? 'rgba(34,197,94,.2)' : 'var(--bdr)') + ';border-radius:8px;margin-bottom:.4rem">'
            + '<span style="font-size:1rem">' + (isActive ? '\u2705' : '\uD83D\uDCE6') + '</span>'
            + '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (c.name || 'Unnamed Catalog') + '</div>'
            + '<div style="font-size:.73rem;color:var(--dim)">ID: ' + c.id + (c.product_count != null ? ' \u00B7 ' + c.product_count + ' products' : '') + '</div></div>'
            + (isActive ? '<span class="badge bg" style="font-size:.68rem">Connected</span>' : '<button class="btn-p btn-sm" style="font-size:.72rem;white-space:nowrap" onclick="doCatMgmtSwitchCatalog(\'' + c.id + '\',\'' + (c.name || '').replace(/'/g, "\\'") + '\')">Connect</button>')
            + '</div>';
        }).join('');
      } else {
        listEl.innerHTML = '<div style="font-size:.78rem;color:var(--dim)">No catalogs found. Create one to get started.</div>';
      }
    }

    // Update button states from live data
    setBtnState('cat-connect-btn', allCatalogs.length > 0 && (!active || allCatalogs.length > 1));
    setBtnState('cat-disconnect-btn', !!active);
    setBtnState('cat-delete-btn', allCatalogs.length > 0);
    setBtnState('cat-diagnostics-btn', !!active);
    setBtnState('cat-sync-btn', !!active);

    // Update status banner if live data differs from cache
    if (active && activeCat) {
      statusEl.innerHTML = '<div style="display:flex;align-items:center;gap:.6rem;padding:.6rem .8rem;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15);border-radius:8px">'
        + '<span style="width:10px;height:10px;border-radius:50%;background:#22c55e;flex-shrink:0"></span>'
        + '<div style="flex:1"><div style="font-weight:600;font-size:.85rem">\uD83D\uDCE6 ' + (activeCat.name || 'Menu Catalog') + '</div>'
        + '<div style="font-size:.73rem;color:var(--dim)">ID: ' + active + (activeCat.product_count != null ? ' \u00B7 ' + activeCat.product_count + ' products' : '') + '</div></div>'
        + '<span class="badge bg" style="font-size:.68rem">Connected</span></div>';
      if (settingsEl) { settingsEl.style.display = 'block'; document.getElementById('cat-settings-name').value = activeCat.name || ''; loadCatalogDetails(); }

      if (!catData.commerce_enabled) {
        statusEl.innerHTML += '<div style="display:flex;align-items:center;gap:.5rem;padding:.5rem .8rem;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;margin-top:.5rem;font-size:.79rem"><span>\u26A0\uFE0F</span><span style="flex:1">Catalog connected but not visible to customers.</span><button class="btn-p btn-sm" onclick="doEnableCommerceSettings()" style="font-size:.72rem;white-space:nowrap">Enable</button></div>';
      }
      if (allCatalogs.length > 1) {
        statusEl.innerHTML += '<div style="display:flex;align-items:center;gap:.5rem;padding:.5rem .8rem;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;margin-top:.4rem;font-size:.79rem"><span>\u26A0\uFE0F</span><span style="flex:1">You have ' + allCatalogs.length + ' catalogs. WhatsApp works best with one.</span><button class="btn-p btn-sm" onclick="doCatalogMerge()" style="font-size:.72rem;white-space:nowrap">Merge</button></div>';
      }
    }

  } catch (e) {
    console.error('[CatalogMgmt] API error:', e.message);
    // Status banner stays as-is from Phase 1 (cached data) — don't blank it
    // Show error in list area with retry
    if (listEl) {
      var fallbackHtml = '';
      if (cachedCatId) {
        fallbackHtml = '<div style="padding:.5rem .7rem;background:var(--ink2);border:1px solid var(--bdr);border-radius:8px;margin-bottom:.4rem;font-size:.82rem">'
          + '\uD83D\uDCE6 <strong>' + cachedCatName + '</strong> <span style="font-size:.72rem;color:var(--dim)">(' + cachedCatId + ')</span>'
          + ' <span style="font-size:.68rem;color:var(--dim);font-style:italic">(cached)</span></div>';
        _catMgmtData = { active_catalog_id: cachedCatId, catalogs: [{ id: cachedCatId, name: cachedCatName, connected: true }] };
      }
      listEl.innerHTML = fallbackHtml + '<div style="padding:.5rem .7rem;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:.78rem;color:#dc2626">\u274C ' + _esc(e.message || 'Failed to load') + ' <button class="btn-g btn-sm" onclick="loadCatalogMgmt(true)" style="font-size:.72rem;margin-left:.5rem">Retry</button></div>';
    }
    // Buttons stay at their Phase 1 state — create always enabled, others based on cache
  }
}

async function loadCatalogDetails() {
  const detailsEl = document.getElementById('cat-settings-details');
  if (!detailsEl) return;
  detailsEl.innerHTML = 'Loading details from Meta...';
  try {
    const d = await api('/api/restaurant/catalog/details');
    const parts = [];
    if (d.product_count != null) parts.push(`${d.product_count} products`);
    if (d.vertical) parts.push(`Type: ${d.vertical}`);
    if (d.created_at) parts.push(`Created: ${new Date(d.created_at).toLocaleDateString()}`);
    detailsEl.textContent = parts.join(' · ') || 'Catalog active';
  } catch (e) {
    detailsEl.textContent = e.message?.includes('no longer exists')
      ? '⚠️ Catalog deleted externally — refresh to update'
      : 'Could not load details';
    detailsEl.style.color = 'var(--dim)';
  }
}

async function doCatMgmtUpdateSettings() {
  const name = document.getElementById('cat-settings-name').value.trim();
  if (!name) { toast('Catalog name cannot be empty', 'err'); return; }
  try {
    await api('/api/restaurant/catalog/settings', { method: 'PUT', body: { name } });
    toast('✅ Catalog name updated', 'ok');
    loadCatalogMgmt();
  } catch (e) { toast('❌ ' + (e.message || 'Failed to update'), 'err'); }
}

function doCatMgmtCreate() {
  const form = document.getElementById('cat-mgmt-create-form');
  const nameInput = document.getElementById('cat-mgmt-name');
  nameInput.value = (rest?.business_name || rest?.brand_name || '') + ' - Menu';
  form.style.display = 'block';
  document.getElementById('cat-mgmt-selector').style.display = 'none';
}

async function doCatMgmtCreateConfirm() {
  const name = document.getElementById('cat-mgmt-name').value.trim();
  if (!name) { toast('Enter a catalog name', 'err'); return; }
  try {
    toast('Creating catalog...', 'ok');
    const r = await api('/api/restaurant/catalog/create-new', { method: 'POST', body: { name } });
    document.getElementById('cat-mgmt-create-form').style.display = 'none';
    toast(`✅ Catalog created: ${r.catalog_name}`, 'ok');
    loadCatalogMgmt(true);
    loadCatalogStatus();
  } catch (e) {
    const msg = e.message || 'Failed to create';
    toast(msg.includes('pending_approval') || msg.includes('Forbidden') ? '⚠️ Restaurant must be approved before creating catalogs' : '❌ ' + msg, 'err');
  }
}

async function doCatMgmtConnect() {
  const sel = document.getElementById('cat-mgmt-select');
  try {
    const catData = await api('/api/restaurant/catalogs?refresh=true');
    if (!catData?.catalogs?.length) { toast('No catalogs found. Create one first.', 'err'); return; }
    sel.innerHTML = catData.catalogs.map(c =>
      `<option value="${c.id}">${c.name || c.id}${c.product_count != null ? ' (' + c.product_count + ' products)' : ''}</option>`
    ).join('');
    document.getElementById('cat-mgmt-selector').style.display = 'block';
    document.getElementById('cat-mgmt-create-form').style.display = 'none';
  } catch (e) { toast('Failed to load catalogs: ' + e.message, 'err'); }
}

async function doCatMgmtConnectConfirm() {
  const catalogId = document.getElementById('cat-mgmt-select').value;
  if (!catalogId) return;
  try {
    toast('Connecting catalog to WhatsApp...', 'ok');
    await api('/api/restaurant/catalog/connect-waba', { method: 'POST', body: { catalog_id: catalogId } });
    document.getElementById('cat-mgmt-selector').style.display = 'none';
    toast('✅ Catalog connected to WhatsApp!', 'ok');
    loadCatalogMgmt(true);
    loadCatalogStatus();
  } catch (e) { toast('❌ ' + (e.message || 'Failed to connect'), 'err'); }
}

async function doCatMgmtDisconnect() {
  if (!confirm('Disconnect catalog from WhatsApp?\n\nYour catalog and menu items will NOT be deleted. You can reconnect anytime.')) return;
  try {
    toast('Disconnecting...', 'ok');
    await api('/api/restaurant/catalog/disconnect-waba', { method: 'POST' });
    toast('✅ Catalog disconnected from WhatsApp', 'ok');
    loadCatalogMgmt(true);
    loadCatalogStatus();
  } catch (e) { toast('❌ ' + (e.message || 'Failed to disconnect'), 'err'); }
}

function doCatMgmtDelete() {
  const catData = _catMgmtData;
  const active = catData?.active_catalog_id || catData?.catalogs?.[0]?.id;
  const activeCat = catData?.catalogs?.find(c => c.id === active) || catData?.catalogs?.[0];
  if (!active) { toast('No catalog to delete', 'err'); return; }

  // Show type-to-confirm panel
  const panel = document.getElementById('cat-mgmt-delete-confirm');
  const input = document.getElementById('cat-delete-input');
  const btn = document.getElementById('cat-delete-confirm-btn');
  panel.style.display = 'block';
  input.value = '';
  btn.disabled = true;
  btn.style.opacity = '.5';

  const expectedName = (activeCat?.name || '').trim();
  input.placeholder = expectedName ? `Type "${expectedName}" to confirm` : 'Type catalog name to confirm';

  // Enable delete button only when name matches
  input.oninput = () => {
    const match = input.value.trim().toLowerCase() === expectedName.toLowerCase();
    btn.disabled = !match;
    btn.style.opacity = match ? '1' : '.5';
  };
}

async function doCatMgmtDeleteConfirm() {
  const active = _catMgmtData?.active_catalog_id || _catMgmtData?.catalogs?.[0]?.id;
  if (!active) return;
  try {
    toast('Deleting catalog...', 'ok');
    document.getElementById('cat-delete-confirm-btn').disabled = true;
    await api(`/api/restaurant/catalog/${active}`, { method: 'DELETE' });
    document.getElementById('cat-mgmt-delete-confirm').style.display = 'none';
    toast('✅ Catalog deleted permanently', 'ok');
    loadCatalogMgmt(true);
    loadCatalogStatus();
  } catch (e) {
    const msg = e.message || 'Failed to delete';
    toast(msg.includes('pending_approval') || msg.includes('Forbidden') ? '⚠️ Restaurant must be approved before deleting catalogs' : '❌ ' + msg, 'err');
    document.getElementById('cat-delete-confirm-btn').disabled = false;
  }
}

// Flow management moved to admin dashboard — restaurants get flow_id assigned by admin

// ── Catalog visibility toggle ───────────────────────────────
async function loadCatalogVisibility() {
  const check = document.getElementById('cat-vis-check');
  const status = document.getElementById('cat-vis-status');
  const section = document.getElementById('cat-visibility-section');
  if (!check || !status) return;

  try {
    const d = await api('/api/restaurant/catalog/visibility-status');
    if (d.error) {
      check.disabled = true;
      status.textContent = d.error;
      return;
    }
    check.checked = d.is_catalog_visible || false;
    check.disabled = !d.has_catalog;
    status.textContent = d.is_catalog_visible
      ? 'Customers can browse your catalog in WhatsApp'
      : d.has_catalog ? 'Catalog is hidden from customers' : 'Connect a catalog first';
  } catch (e) {
    check.disabled = true;
    status.textContent = 'Could not check visibility status';
  }
}

async function doToggleCatalogVisibility(visible) {
  const check = document.getElementById('cat-vis-check');
  const status = document.getElementById('cat-vis-status');
  status.textContent = 'Updating...';
  check.disabled = true;

  try {
    await api('/api/restaurant/catalog/visibility-toggle', { method: 'POST', body: { visible } });
    status.textContent = visible
      ? 'Customers can browse your catalog in WhatsApp'
      : 'Catalog is hidden from customers';
    toast(visible ? '✅ Catalog is now visible to customers' : 'Catalog hidden from customers', 'ok');
  } catch (e) {
    // Revert toggle on failure
    check.checked = !visible;
    status.textContent = 'Failed to update — please try again';
    toast('❌ ' + (e.message || 'Failed to update visibility'), 'err');
  } finally {
    check.disabled = false;
  }
}

// ── Switch connected catalog (disconnect old, connect new) ──
async function doCatMgmtSwitchCatalog(newCatId, newCatName) {
  const current = _catMgmtData?.active_catalog_id;
  const currentName = _catMgmtData?.catalogs?.find(c => c.id === current)?.name || 'current catalog';
  if (!confirm(`This will disconnect "${currentName}" and connect "${newCatName}" to WhatsApp.\n\nContinue?`)) return;
  try {
    await api('/api/restaurant/catalog/switch', { method: 'POST', body: { catalog_id: newCatId } });
    toast(`✅ Switched to "${newCatName}"`, 'ok');
    loadCatalogMgmt(true);
  } catch (e) { toast('❌ ' + (e.message || 'Failed to switch catalog'), 'err'); }
}

// ── Enable commerce settings on phone number ──
async function doEnableCommerceSettings() {
  try {
    await api('/api/restaurant/catalog/link', { method: 'POST' });
    toast('✅ Catalog now visible to customers on WhatsApp', 'ok');
    loadCatalogMgmt(true);
  } catch (e) { toast('❌ ' + (e.message || 'Failed to enable'), 'err'); }
}

// ── Bulk assign unassigned items to a branch ─────────────
async function doBulkAssignAll() {
  const branchSel = document.getElementById('bulk-assign-branch');
  const branchId = branchSel?.value;
  if (!branchId) { toast('Select a branch to assign items to', 'err'); return; }

  // Get all unassigned item IDs from the current table
  const items = await api('/api/restaurant/menu/unassigned').catch(() => []);
  const itemIds = (items || []).map(i => i.id || i._id);
  if (!itemIds.length) { toast('No unassigned items to assign', 'err'); return; }

  try {
    const r = await api('/api/restaurant/menu/bulk-assign-branch', { method: 'POST', body: { item_ids: itemIds, branch_id: branchId } });
    toast(`✅ ${r.assigned} items assigned to ${r.branch_name}`, 'ok');
    loadMenu();
  } catch (e) { toast('❌ ' + (e.message || 'Failed to assign'), 'err'); }
}

// ── Catalog merge (multiple catalogs → one) ─────────────
async function doCatalogMerge() {
  if (!confirm('Merge all catalogs into one?\n\nThis will:\n• Copy items from secondary catalogs to the primary\n• Skip duplicate items (same name + price)\n• Disconnect secondary catalogs from WhatsApp\n\nContinue?')) return;
  try {
    toast('Merging catalogs... this may take a moment', 'ok');
    const r = await api('/api/restaurant/catalog/merge', { method: 'POST' });
    if (r.merged === 0) {
      toast('Only one catalog found — no merge needed', 'ok');
    } else {
      toast(`✅ Merged ${r.merged} catalogs. ${r.total_copied} items copied, ${r.duplicates_skipped} duplicates skipped`, 'ok');
    }
    loadCatalogMgmt(true);
  } catch (e) {
    const msg = e.message || 'Unknown error';
    toast(msg.includes('pending_approval') || msg.includes('Forbidden') ? '⚠️ Restaurant must be approved before merging catalogs' : '❌ Merge failed: ' + msg, 'err');
  }
}

async function doChangePassword() {
  const btn = document.getElementById('cp-btn');
  const cur = document.getElementById('cp-current').value;
  const np  = document.getElementById('cp-new').value;
  const nc  = document.getElementById('cp-confirm').value;
  if (!np || np.length < 8) return toast('New password must be at least 8 characters', 'err');
  if (np !== nc) return toast('Passwords do not match', 'err');
  btn.disabled = true; btn.textContent = 'Updating…';
  try {
    const d = await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: np } });
    if (d && d.ok) {
      toast('Password updated!', 'ok');
      document.getElementById('cp-current').value = '';
      document.getElementById('cp-new').value = '';
      document.getElementById('cp-confirm').value = '';
    } else toast(d.error || 'Failed', 'err');
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Update Password'; }
}

async function doDeleteAccount() {
  const confirmEmail = document.getElementById('delete-confirm-email').value.trim();
  const actualEmail  = rest?.email;
  if (!confirmEmail || confirmEmail.toLowerCase() !== (actualEmail || '').toLowerCase()) {
    return toast('Email does not match — please type your account email to confirm', 'err');
  }
  const btn = document.getElementById('delete-confirm-btn');
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    await api('/auth/delete-account', { method: 'DELETE' });
    toast('Account deleted', 'ok');
    localStorage.removeItem('zm_token');
    setTimeout(() => { window.location.href = '/'; }, 1200);
  } catch (e) {
    toast(e.message || 'Failed to delete account', 'err');
    btn.disabled = false; btn.textContent = 'Yes, Delete My Account';
  }
}

async function _finishMetaConnect(code, accessToken) {
  try {
    const d = await api('/auth/connect-meta', { method: 'POST', body: {
      code: code || null,
      accessToken: accessToken || null,
      fromJsSdk: !!code, // only true when code comes from FB.login() JS SDK
      sessionInfo: _embeddedSignupSessionInfo || null,
      pageUrl: window.location.origin + window.location.pathname,
    } });
    if (d.connected || d.ok) {
      toast('WhatsApp connected!', 'ok');
      rest = await api('/auth/me');
      // Hide banners and update all status indicators
      document.getElementById('wa-connect-banner').style.display  = 'none';
      if (rest.approval_status !== 'approved') document.getElementById('pending-banner').style.display = 'flex';
      loadProfile();
      renderWizard();
    } else {
      toast(d.error || 'Connection failed', 'err');
    }
  } catch (e) { toast(e.message || 'Connection failed', 'err'); }
  _setConnectBtns(false);
}

// Capture session info (phone_number_id + waba_id) from Meta Embedded Signup popup
let _embeddedSignupSessionInfo = null;
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;
  try {
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (data?.type === 'WA_EMBEDDED_SIGNUP') {
      if (data.event === 'FINISH') {
        _embeddedSignupSessionInfo = data.data || null;
        console.log('[GullyBite] Embedded signup session info captured:', _embeddedSignupSessionInfo);
      } else if (data.event === 'CANCEL' || data.event === 'ERROR') {
        _embeddedSignupSessionInfo = null;
      }
    }
  } catch (_) {}
});

// Listen for postMessage from popup window (OAuth redirect inside popup)
window.addEventListener('message', async (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== 'GULLYBITE_OAUTH') return;
  const { meta_token, code, error } = event.data;
  if (error) { toast('Connection failed: ' + error, 'err'); _setConnectBtns(false); return; }
  if (meta_token) {
    localStorage.setItem('zm_token', meta_token);
    token = meta_token;
    toast('WhatsApp connected!', 'ok');
    rest = await api('/auth/me');
    document.getElementById('wa-connect-banner').style.display = 'none';
    if (rest.approval_status !== 'approved') document.getElementById('pending-banner').style.display = 'flex';
    loadProfile();
    _setConnectBtns(false);
  } else if (code) {
    await _finishMetaConnect(code, null);
  }
});

function doBannerConnect() { _doMetaConnect(); }
function doReconnectMeta() { _doMetaConnect(); }

async function verifyMetaConnection() {
  const btn = document.getElementById('wa-verify-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
  try {
    const d = await api('/api/restaurant/whatsapp/verify-connection', { method: 'POST' });
    if (d.connected) {
      toast(`Connection verified! ${d.verified?.length || d.discovered || 0} account(s) found.`, 'ok');
      rest = await api('/auth/me');
      loadProfile();
      loadWA();
      document.getElementById('wa-connect-banner').style.display = 'none';
    } else {
      toast('No WhatsApp accounts found. Try reconnecting via OAuth.', 'err');
    }
  } catch (e) {
    toast(e.message || 'Verification failed', 'err');
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Verify Existing Connection'; }
}

function _setBtnLoading(id, loading, defaultHtml) {
  const el = document.getElementById(id);
  if (!el) return;
  el.disabled = loading;
  if (loading) el.innerHTML = '<span style="display:inline-flex;align-items:center;gap:.4rem"><span style="width:12px;height:12px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block"></span> Connecting…</span>';
  else if (defaultHtml) el.innerHTML = defaultHtml;
}

const BANNER_BTN_HTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg> Connect WhatsApp Now';

function _resetConnectBtns() {
  _setBtnLoading('banner-connect-btn', false, BANNER_BTN_HTML);
  _setBtnLoading('wa-reconnect-btn', false, 'Connect / Reconnect WhatsApp Business');
}
// Keep _setConnectBtns for backwards compat with message listener
function _setConnectBtns(loading) {
  if (loading) {
    _setBtnLoading('banner-connect-btn', true);
    _setBtnLoading('wa-reconnect-btn', true);
  } else {
    _resetConnectBtns();
  }
}

function _showDashFallback() {
  const el = document.getElementById('dash-connect-fallback');
  if (el) el.style.display = 'inline';
}

function _doMetaConnect() {
  _setBtnLoading('banner-connect-btn', true);
  _setBtnLoading('wa-reconnect-btn', true);

  if (typeof FB === 'undefined' || typeof FB.login !== 'function') {
    toast('Facebook SDK not loaded. Redirecting to Meta login…', 'nfo');
    _resetConnectBtns();
    window.location.href = `https://www.facebook.com/v25.0/dialog/oauth?client_id=1670288721053166&redirect_uri=${encodeURIComponent(location.origin + '/auth/callback')}&scope=business_management,whatsapp_business_management,whatsapp_business_messaging`;
    return;
  }

  // Safety timeout — if popup blocked, show redirect fallback
  let callbackFired = false;
  setTimeout(() => {
    if (!callbackFired) {
      _resetConnectBtns();
      _showDashFallback();
      toast('Popup may have been blocked. Use the redirect link or allow popups.', 'err');
    }
  }, 8000);

  // Override window.open to force proper popup dimensions for Meta Embedded Signup
  const _origOpen = window.open;
  window.open = function(url, name, features) {
    const w = 580, h = 680;
    const left = Math.round(window.screenX + (window.outerWidth  - w) / 2);
    const top  = Math.round(window.screenY + (window.outerHeight - h) / 2);
    return _origOpen.call(window, url, name,
      `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`);
  };

  try {
    FB.login(async resp => {
      window.open = _origOpen; // restore after popup closes
      callbackFired = true;
      console.log('[GullyBite] FB.login response:', JSON.stringify(resp));
      if (resp.authResponse?.code) {
        await _finishMetaConnect(resp.authResponse.code, null);
        return;
      }
      // authResponse null — popup closed or navigated away
      toast('Verifying connection…', 'nfo');
      await new Promise(r => setTimeout(r, 2000));
      const fresh = await api('/auth/me').catch(() => null);
      if (fresh?.whatsapp_connected || fresh?.meta_user_id) {
        toast('WhatsApp connected!', 'ok');
        rest = fresh;
        document.getElementById('wa-connect-banner').style.display = 'none';
        if (rest.approval_status !== 'approved') document.getElementById('pending-banner').style.display = 'flex';
        loadProfile();
        renderWizard();
      } else {
        toast('Connection cancelled — please try again.', 'err');
        _showDashFallback();
      }
      _resetConnectBtns();
    }, {
      config_id: '967221625965151',
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
    });
  } catch (err) {
    window.open = _origOpen; // restore on error
    console.error('[GullyBite] FB.login error:', err);
    toast('Redirecting to Meta login…', 'nfo');
    _resetConnectBtns();
    window.location.href = `https://www.facebook.com/v25.0/dialog/oauth?client_id=1670288721053166&redirect_uri=${encodeURIComponent(location.origin + '/auth/callback')}&scope=business_management,whatsapp_business_management,whatsapp_business_messaging`;
  }
}


const INT_DEFS = {
  petpooja: {
    name   : 'PetPooja',
    emoji  : '🟣',
    cls    : 'petpooja',
    desc   : 'Sync your PetPooja POS menu directly — categories, items, prices and availability.',
    apiNote: 'Get your API Key, Access Token and Restaurant ID from your PetPooja developer account.',
    fields : [
      { id: 'api_key',      label: 'API Key',        ph: 'pp_xxxxxxxxxxxxxxxx',  type: 'text' },
      { id: 'access_token', label: 'Access Token',   ph: 'at_xxxxxxxxxxxxxxxx',  type: 'text' },
      { id: 'outlet_id',    label: 'Restaurant ID',  ph: '12345',                type: 'text' },
    ],
  },
  urbanpiper: {
    name   : 'UrbanPiper',
    emoji  : '🔵',
    cls    : 'urbanpiper',
    desc   : 'Connect via UrbanPiper to sync menus from Swiggy, Zomato & more. Orders auto-push to your POS.',
    apiNote: 'Get your API Key and API Secret from your UrbanPiper dashboard → Settings → API Keys.',
    fields : [
      { id: 'api_key',    label: 'API Key',    ph: 'up_xxxxxxxxxxxxxxxx', type: 'text' },
      { id: 'api_secret', label: 'API Secret', ph: 'secret_xxxxxxxxxxxx', type: 'text' },
      { id: 'outlet_id',  label: 'Store / Location ID', ph: '12345',      type: 'text' },
    ],
  },
  dotpe: {
    name   : 'DotPe',
    emoji  : '🟡',
    cls    : 'dotpe',
    desc   : 'Sync your DotPe POS menu and push WhatsApp orders to your DotPe dashboard automatically.',
    apiNote: 'Get your Partner API Key, Access Token and Store ID from your DotPe partner account.',
    fields : [
      { id: 'api_key',      label: 'Partner API Key', ph: 'dp_xxxxxxxxxxxxxxxx', type: 'text' },
      { id: 'access_token', label: 'Access Token',    ph: 'at_xxxxxxxxxxxxxxxx', type: 'text' },
      { id: 'outlet_id',    label: 'Store / Outlet ID', ph: '12345',             type: 'text' },
    ],
  },
  /* ═══ FUTURE FEATURE: Swiggy Integration ═══
     Requires Swiggy Partner API approval (apply at partner.swiggy.com).
     swiggy: {
       name   : 'Swiggy',
       emoji  : '🟠',
       cls    : 'swiggy',
       desc   : 'Pull your Swiggy menu automatically. Requires official Swiggy Partner API access.',
       apiNote: 'Apply for Swiggy Partner API access at partner.swiggy.com.',
       fields : [
         { id: 'api_key',   label: 'API Key',   ph: 'sw_xxxxxxxxxxxxxxxx', type: 'text' },
         { id: 'outlet_id', label: 'Outlet ID', ph: '123456',              type: 'text' },
       ],
     },
     ═══ END FUTURE FEATURE ═══ */
  /* ═══ FUTURE FEATURE: Zomato Integration ═══
     Requires Zomato for Business API approval (apply at zomato.com/business).
     zomato: {
       name   : 'Zomato',
       emoji  : '🔴',
       cls    : 'zomato',
       desc   : 'Import your Zomato menu automatically. Requires Zomato for Business API credentials.',
       apiNote: 'Register at zomato.com/business to get your API Key and Restaurant ID.',
       fields : [
         { id: 'api_key',    label: 'API Key / Client ID',    ph: 'zm_xxxxxxxxxxxxxxxx', type: 'text' },
         { id: 'api_secret', label: 'Client Secret',          ph: 'optional',            type: 'text' },
         { id: 'outlet_id',  label: 'Restaurant ID (res_id)', ph: '12345',               type: 'text' },
       ],
     },
     ═══ END FUTURE FEATURE ═══ */
};

let intData       = {};  // platform -> row from DB
let intActivePlatform = null;

const POS_DISABLED = true; // POS integrations not yet active — flip when ENABLE_POS_INTEGRATIONS=true

async function loadIntegrations() {
  const grid   = document.getElementById('int-grid');

  if (POS_DISABLED) {
    // Show greyed-out tiles with "Coming Soon" overlay
    grid.innerHTML = Object.entries(INT_DEFS).map(([p, d]) =>
      `<div class="int-tile" style="opacity:.5;cursor:not-allowed;pointer-events:none;position:relative">
         <div class="int-tile-hd">
           <div class="int-logo ${d.cls}">${d.emoji}</div>
           <div>
             <div class="int-tile-name">${d.name}</div>
             <div><span class="badge bd" style="background:var(--ink4);color:var(--mute)">Coming soon</span></div>
           </div>
         </div>
         <div class="int-tile-desc">${d.desc}</div>
         <div class="int-sync-info">POS integrations coming soon</div>
       </div>`
    ).join('');
    // Replace sync log with coming-soon message
    document.getElementById('int-log-body').innerHTML =
      '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--dim)">POS integrations are not yet active. Contact GullyBite support for early access.</td></tr>';
    return;
  }

  grid.innerHTML = Object.entries(INT_DEFS).map(([p, d]) =>
    `<div class="int-tile" id="int-tile-${p}" onclick="openIntModal('${p}')">
       <div class="int-tile-hd">
         <div class="int-logo ${d.cls}">${d.emoji}</div>
         <div>
           <div class="int-tile-name">${d.name}</div>
           <div id="int-badge-${p}"><span class="badge bd">Not connected</span></div>
         </div>
         <div style="margin-left:auto" onclick="event.stopPropagation()">
           <label class="tsl"><input type="checkbox" id="int-tog-${p}" onchange="doToggleInt('${p}',this.checked)"><div class="tsl-track"></div></label>
         </div>
       </div>
       <div class="int-tile-desc">${d.desc}</div>
       <div class="int-sync-info" id="int-sync-${p}">Click to configure</div>
     </div>`
  ).join('');

  try {
    const rows = await api('/api/restaurant/integrations');
    intData = {};
    (rows || []).forEach(r => { intData[r.platform] = r; });
    Object.entries(INT_DEFS).forEach(([p]) => refreshIntTile(p));
    renderIntLog();
  } catch (e) { toast('Could not load integrations', 'err'); }
}

function refreshIntTile(platform) {
  const row  = intData[platform];
  const badge = document.getElementById(`int-badge-${platform}`);
  const tog   = document.getElementById(`int-tog-${platform}`);
  const sync  = document.getElementById(`int-sync-${platform}`);
  const tile  = document.getElementById(`int-tile-${platform}`);
  if (!badge) return;

  if (!row) {
    badge.innerHTML = `<span class="badge bd">Not connected</span>`;
    if (tog) tog.checked = false;
    if (sync) sync.textContent = 'Click to configure';
    tile?.classList.remove('connected');
    return;
  }

  const statusMap = { idle: ['bd','Configured'], syncing: ['bb','Syncing…'], success: ['bg','Connected'], error: ['br','Sync error'] };
  const [cls, label] = statusMap[row.sync_status] || ['bd','Configured'];
  badge.innerHTML = `<span class="badge ${cls}">${label}</span>`;
  if (tog) tog.checked = row.is_active;
  if (row.last_synced_at) {
    const lsr = row.last_sync_result
    const variantInfo = lsr && lsr.variants_created ? ` (${lsr.variants_created} with variants)` : ''
    const totalItems = lsr && lsr.total_items ? lsr.total_items : row.item_count
    if (sync) sync.textContent = `${totalItems} items${variantInfo} · synced ${timeAgo(row.last_synced_at)}`
  } else {
    if (sync) sync.textContent = row.is_active ? 'Active — not synced yet' : 'Configured but disabled';
  }
  if (row.is_active && row.sync_status === 'success') tile?.classList.add('connected');
  else tile?.classList.remove('connected');
}

function renderIntLog() {
  const tb = document.getElementById('int-log-body');
  const rows = Object.values(intData);
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="7"><div class="empty"><div class="ei">🔗</div><h3>No integrations connected yet</h3><p>Click a tile above to configure</p></div></td></tr>`;
    return;
  }
  tb.innerHTML = rows.map(r => {
    const def = INT_DEFS[r.platform] || {};
    const statusCls = { idle: 'bd', syncing: 'bb', success: 'bg', error: 'br' }[r.sync_status] || 'bd';
    const variantsCreated = r.last_sync_result?.variants_created || 0
    return `<tr>
      <td><strong>${def.emoji || ''} ${def.name || r.platform}</strong></td>
      <td style="font-size:.78rem;color:var(--dim)">${r.branch_id ? 'Branch set' : '—'}</td>
      <td>${r.item_count || 0}</td>
      <td>${variantsCreated}</td>
      <td style="font-size:.78rem;color:var(--dim)">${r.last_synced_at ? timeAgo(r.last_synced_at) : 'Never'}</td>
      <td><span class="badge ${statusCls}">${r.sync_status}</span>${r.sync_error ? `<div style="font-size:.68rem;color:var(--red);margin-top:.2rem">${r.sync_error.substring(0,60)}</div>` : ''}</td>
      <td><button class="btn-g btn-sm" onclick="doSyncPlatform('${r.platform}')">🔄 Sync</button></td>
    </tr>`;
  }).join('');
}

async function doToggleInt(platform, isActive) {
  try {
    const r = await api(`/api/restaurant/integrations/${platform}/toggle`, { method: 'PATCH', body: { isActive } });
    if (intData[platform]) intData[platform].is_active = r.isActive;
    refreshIntTile(platform);
    toast(`${INT_DEFS[platform]?.name} ${r.isActive ? 'enabled — initial sync triggered' : 'disabled'}`, 'ok');
    if (r.isActive) setTimeout(() => loadIntegrations(), 3500); // refresh after sync
  } catch (e) { toast(e.message, 'err'); }
}

function openIntModal(platform) {
  intActivePlatform = platform;
  const def = INT_DEFS[platform];
  const row = intData[platform] || {};

  document.getElementById('im-logo').className = `int-logo ${def.cls}`;
  document.getElementById('im-logo').textContent = def.emoji;
  document.getElementById('im-title').textContent = `Connect ${def.name}`;
  document.getElementById('im-subtitle').textContent = 'Enter your API credentials below';

  // Build branch dropdown
  const branchOpts = branches.map(b =>
    `<option value="${b.id}" ${row.branch_id === b.id ? 'selected' : ''}>${b.name}</option>`
  ).join('');

  document.getElementById('im-body').innerHTML = `
    <div class="fgrid" style="grid-template-columns:1fr">
      <div class="fg">
        <label>Sync into Branch ★</label>
        <select id="im-branch">
          <option value="">Select a branch…</option>
          ${branchOpts}
        </select>
      </div>
      ${def.fields.map(f => `
        <div class="fg">
          <label>${f.label}</label>
          <input id="im-${f.id}" type="${f.type || 'text'}" placeholder="${f.ph}"
            value="${row[f.id] && ['api_key','api_secret','access_token'].includes(f.id) ? '••••••••' : ''}">
        </div>`).join('')}
    </div>
    <div class="int-api-note">ℹ️ ${def.apiNote}</div>`;

  // Show Sync Now + sync mode toggle only if already configured
  const syncBtn = document.getElementById('im-sync-btn')
  syncBtn.style.display = row.sync_status ? 'inline-flex' : 'none'

  // Remove old sync mode toggle if present
  const oldSyncMode = document.getElementById('im-sync-mode-wrap')
  if (oldSyncMode) oldSyncMode.remove()

  if (row.sync_status) {
    const modeDiv = document.createElement('div')
    modeDiv.id = 'im-sync-mode-wrap'
    modeDiv.style.cssText = 'font-size:.72rem;color:var(--dim);margin-top:.4rem;width:100%'
    modeDiv.innerHTML = `
      <label><input type="radio" name="im-sync-mode" value="incremental" checked> Incremental (merge changes)</label>
      <label style="margin-left:.8rem"><input type="radio" name="im-sync-mode" value="full_replace"> Full Replace</label>`
    syncBtn.parentElement.appendChild(modeDiv)
  }

  document.getElementById('int-modal').classList.add('on');
}

function closeIntModal() {
  document.getElementById('int-modal').classList.remove('on');
  intActivePlatform = null;
}

async function doSaveIntegration() {
  const platform = intActivePlatform;
  if (!platform) return;
  const def = INT_DEFS[platform];
  const branchId = document.getElementById('im-branch').value;
  if (!branchId) return toast('Please select a branch to sync into', 'err');

  const body = { branchId };
  def.fields.forEach(f => {
    const val = document.getElementById(`im-${f.id}`)?.value?.trim();
    if (val && val !== '••••••••') body[snakeToCamel(f.id)] = val;
  });

  const btn = document.getElementById('im-save-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Saving…';
  try {
    await api(`/api/restaurant/integrations/${platform}`, { method: 'POST', body });
    toast(`${def.name} credentials saved!`, 'ok');
    closeIntModal();
    await loadIntegrations();
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = 'Save &amp; Connect'; }
}

async function doSyncIntegration() {
  const platform = intActivePlatform;
  if (!platform) return;
  const syncModeEl = document.querySelector('input[name="im-sync-mode"]:checked')
  const syncMode = syncModeEl ? syncModeEl.value : 'incremental'
  if (syncMode === 'full_replace') {
    if (!confirm('This will deactivate all POS items and reimport from scratch. Continue?')) return
  }
  const btn = document.getElementById('im-sync-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Syncing…';
  try {
    const r = await api(`/api/restaurant/integrations/${platform}/sync`, { method: 'POST', body: { syncMode } });
    toast(`Sync complete — ${r.inserted || 0} inserted, ${r.updated || 0} updated`, 'ok');
    closeIntModal();
    showSyncResults(platform, r)
    await loadIntegrations();
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '🔄 Sync Now'; }
}

async function doSyncPlatform(platform) {
  try {
    toast(`Syncing ${INT_DEFS[platform]?.name}…`, 'nfo');
    const r = await api(`/api/restaurant/integrations/${platform}/sync`, { method: 'POST', body: { syncMode: 'incremental' } });
    toast(`${INT_DEFS[platform]?.name}: ${r.inserted || 0} inserted, ${r.updated || 0} updated`, 'ok');
    showSyncResults(platform, r)
    await loadIntegrations();
  } catch (e) { toast(e.message, 'err'); }
}

async function doRemoveIntegration() {
  const platform = intActivePlatform;
  if (!platform) return;
  if (!confirm(`Remove ${INT_DEFS[platform]?.name} integration? This will not delete any menu items.`)) return;
  try {
    await api(`/api/restaurant/integrations/${platform}`, { method: 'DELETE' });
    delete intData[platform];
    toast('Integration removed', 'ok');
    closeIntModal();
    await loadIntegrations();
  } catch (e) { toast(e.message, 'err'); }
}

function showSyncResults(platform, r) {
  const panel = document.getElementById('int-sync-results')
  if (!panel || !r.success) return
  const def = INT_DEFS[platform] || {}
  const cats = (r.tag_summary || []).map(t => `${t.tag} (${t.count})`).join(', ') || 'None'
  panel.style.display = 'block'
  panel.innerHTML = `
    <div class="card" style="background:#f0fdf4;border:1px solid #bbf7d0;margin-top:1rem">
      <div class="ch"><h3 style="color:#166534">Menu Sync Results — ${def.name || platform}</h3></div>
      <div class="cb" style="padding:1rem 1.4rem;font-size:.84rem;line-height:1.7">
        <div><strong>Inserted:</strong> ${r.inserted || 0} new items</div>
        <div><strong>Updated:</strong> ${r.updated || 0} items</div>
        <div><strong>Unchanged:</strong> ${r.unchanged || 0} items</div>
        <div><strong>Deactivated:</strong> ${r.deactivated || 0} items</div>
        <div><strong>Variants:</strong> ${r.variants_created || 0} items → ${r.total_items || 0} variant rows</div>
        <div style="margin-top:.4rem"><strong>Categories:</strong> ${cats}</div>
        <div style="margin-top:.8rem;display:flex;gap:.5rem">
          <button class="btn-p btn-sm" onclick="openVariantModal('${platform}')">View Variant Mapping</button>
          <button class="btn-g btn-sm" onclick="dismissSyncResults()">Dismiss</button>
        </div>
      </div>
    </div>`
}

function dismissSyncResults() {
  const panel = document.getElementById('int-sync-results')
  if (panel) { panel.style.display = 'none'; panel.innerHTML = '' }
}

let _variantPlatform = null
async function openVariantModal(platform) {
  _variantPlatform = platform
  const modal = document.getElementById('int-variant-modal')
  const body = document.getElementById('int-variant-body')
  modal.style.display = 'flex'
  body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--dim)">Loading…</div>'
  try {
    const data = await api(`/api/restaurant/integrations/${platform}/variants`)
    const groups = data.variant_groups || []
    if (!groups.length) {
      body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--dim)">No variant groups found</div>'
      return
    }
    body.innerHTML = `
      <div class="tbl">
        <table>
          <thead><tr><th>POS Item</th><th>Variants Found</th><th>item_group_id</th><th>Rows Created</th></tr></thead>
          <tbody>${groups.map(g => {
            const variantNames = (g.variants || []).map(v => v.size).join(', ')
            return `<tr>
              <td><strong>${g.name}</strong></td>
              <td style="font-size:.78rem">${variantNames}</td>
              <td style="font-size:.78rem;color:var(--dim)">${g.item_group_id}</td>
              <td>${(g.variants || []).length}</td>
            </tr>`
          }).join('')}</tbody>
        </table>
      </div>`
  } catch (e) {
    body.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--red)">Failed to load variants: ${_esc(e.message)}</div>`
  }
}

function closeVariantModal() {
  document.getElementById('int-variant-modal').style.display = 'none'
  _variantPlatform = null
}

// snake_case → camelCase helper for field IDs
function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}


async function loadFeedStatus() {
  const area = document.getElementById('feed-status-area');
  if (!area) return;
  try {
    const s = await api('/api/restaurant/catalog/feed-status');
    if (!s.registered) {
      area.innerHTML = `<div style="font-size:.83rem;color:var(--dim)">
        <span style="color:var(--gold2)">⚠ Feed not registered yet.</span>
        Click "Register Feed with Meta" below — Meta will fetch your menu daily and keep the catalog in sync.
      </div>`;
    } else {
      const lastSync = s.lastUpload?.end_time
        ? new Date(s.lastUpload.end_time).toLocaleString('en-IN')
        : 'Not synced yet';
      const items = s.lastUpload?.num_detected_items ?? '—';
      const invalid = s.lastUpload?.num_invalid_items ?? 0;
      area.innerHTML = `
        <div style="display:grid;gap:.5rem;font-size:.82rem">
          <div style="display:flex;gap:.5rem;align-items:center">
            <span style="color:var(--wa);font-size:1rem">✅</span>
            <strong>Feed registered with Meta</strong>
            <span style="color:var(--dim);font-size:.75rem">(syncs daily at 2 AM)</span>
          </div>
          <div style="background:var(--ink2);border-radius:8px;padding:.6rem .85rem;display:flex;flex-direction:column;gap:.25rem">
            <div style="color:var(--dim);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em">Feed URL</div>
            <div style="font-family:monospace;font-size:.75rem;word-break:break-all;color:var(--fg)">${s.feedUrl}</div>
          </div>
          <div style="display:flex;gap:1.5rem;font-size:.8rem;flex-wrap:wrap">
            <span>🕐 Last sync: <strong>${lastSync}</strong></span>
            <span>📦 Items detected: <strong>${items}</strong></span>
            ${invalid > 0 ? `<span style="color:var(--red)">⚠ ${invalid} invalid</span>` : ''}
          </div>
        </div>`;
    }
  } catch (e) {
    if (area) area.innerHTML = `<span style="color:var(--dim);font-size:.82rem">Could not load feed status</span>`;
  }
  loadFeedList();
}

async function loadFeedList() {
  var area = document.getElementById('feed-list-area');
  if (!area) return;
  try {
    var data = await api('/api/restaurant/catalog/feeds');
    var feeds = data.feeds || [];
    if (!feeds.length) {
      area.innerHTML = '<div style="font-size:.78rem;color:var(--dim)">No feeds found on this catalog.</div>';
      return;
    }
    area.innerHTML = feeds.map(function(f) {
      var schedule = f.schedule ? (f.schedule.interval || '') + (f.schedule.hour != null ? ' at ' + f.schedule.hour + ':00' : '') : '';
      var upload = f.latest_upload || {};
      var uploadInfo = upload.end_time
        ? 'Last: ' + new Date(upload.end_time).toLocaleDateString('en-IN') + ' \u2014 ' + (upload.num_detected_items || 0) + ' items' + (upload.num_invalid_items ? ', ' + upload.num_invalid_items + ' invalid' : '')
        : 'No uploads yet';
      return '<div style="display:flex;align-items:center;gap:.6rem;padding:.5rem .7rem;background:var(--ink2);border:1px solid var(--bdr);border-radius:8px;margin-bottom:.4rem">'
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-weight:600;font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (f.name || 'Unnamed Feed') + '</div>'
        + '<div style="font-size:.72rem;color:var(--dim)">ID: ' + f.id + (schedule ? ' \u00B7 ' + schedule : '') + '</div>'
        + '<div style="font-size:.72rem;color:var(--dim)">' + uploadInfo + '</div>'
        + '</div>'
        + '<button class="btn-g btn-sm" style="color:#dc2626;border-color:#dc2626;font-size:.72rem;white-space:nowrap" onclick="doDeleteFeed(\'' + f.id + '\',\'' + (f.name || '').replace(/'/g, "\\'") + '\')">\uD83D\uDDD1 Delete</button>'
        + '</div>';
    }).join('');
  } catch (e) {
    area.innerHTML = '<div style="font-size:.78rem;color:var(--dim)">Could not load feed list</div>';
  }
}

async function doDeleteFeed(feedId, feedName) {
  if (!confirm('Delete feed \'' + (feedName || feedId) + '\'?\n\nThis will stop Meta from syncing items through this feed. The catalog and its items are not affected.')) return;
  try {
    await api('/api/restaurant/catalog/feed/' + feedId, { method: 'DELETE' });
    toast('Feed deleted', 'ok');
    loadFeedList();
    loadFeedStatus();
  } catch (e) {
    toast(e.message || 'Failed to delete feed', 'err');
  }
}

async function loadCatalogDiagnostics() {
  var area = document.getElementById('cat-diagnostics-area');
  if (!area) return;
  area.style.display = 'block';
  area.innerHTML = '<div style="text-align:center;padding:.8rem"><div class="spin" style="margin:0 auto;width:18px;height:18px"></div></div>';

  try {
    var data = await api('/api/restaurant/catalog/diagnostics');
    var diag = data.diagnostics || [];
    var items = data.problematic_items || [];

    if (!diag.length && !items.length) {
      area.innerHTML = '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:.8rem;font-size:.82rem">'
        + '<button onclick="document.getElementById(\'cat-diagnostics-area\').style.display=\'none\'" style="float:right;background:none;border:none;cursor:pointer;font-size:1rem">\u2715</button>'
        + '\u2705 No issues found \u2014 all catalog items are healthy.</div>';
      return;
    }

    var html = '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:.8rem">';
    html += '<button onclick="document.getElementById(\'cat-diagnostics-area\').style.display=\'none\'" style="float:right;background:none;border:none;cursor:pointer;font-size:1rem">\u2715</button>';

    if (diag.length) {
      html += '<div style="font-weight:600;font-size:.85rem;margin-bottom:.5rem">\u26A0\uFE0F Catalog Issues</div>';
      diag.forEach(function(d) {
        html += '<div style="font-size:.8rem;margin-bottom:.3rem">\u2022 <strong>' + (d.diagnostics_type || 'Unknown') + '</strong>: ' + (d.num_items || 0) + ' items affected</div>';
      });
    }

    if (items.length) {
      html += '<div style="font-weight:600;font-size:.85rem;margin:.6rem 0 .4rem">Items with issues (first ' + items.length + ')</div>';
      html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.78rem">';
      html += '<thead><tr style="border-bottom:1px solid var(--rim)"><th style="text-align:left;padding:.3rem .5rem">retailer_id</th><th style="text-align:left;padding:.3rem .5rem">Name</th><th style="text-align:center;padding:.3rem .5rem">Status</th><th style="text-align:left;padding:.3rem .5rem">Error</th></tr></thead><tbody>';
      items.forEach(function(it) {
        var errText = (it.errors || []).map(function(e) { return e.message || e.code || ''; }).join(', ') || '\u2014';
        html += '<tr style="border-bottom:1px solid var(--rim)">';
        html += '<td style="padding:.3rem .5rem;font-family:monospace;font-size:.72rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (it.retailer_id || it.id || '\u2014') + '</td>';
        html += '<td style="padding:.3rem .5rem">' + (it.name || '\u2014') + '</td>';
        html += '<td style="padding:.3rem .5rem;text-align:center"><span class="badge ba" style="font-size:.65rem">' + (it.review_status || '\u2014') + '</span></td>';
        html += '<td style="padding:.3rem .5rem;font-size:.72rem;color:var(--red);max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + errText + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    }

    html += '</div>';
    area.innerHTML = html;
  } catch (e) {
    area.innerHTML = '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:.8rem;font-size:.82rem">'
      + '<button onclick="document.getElementById(\'cat-diagnostics-area\').style.display=\'none\'" style="float:right;background:none;border:none;cursor:pointer;font-size:1rem">\u2715</button>'
      + '\u274C Failed to load diagnostics: ' + (e.message || 'Unknown error') + '</div>';
  }
}

async function doRegisterFeed(btn) {
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Registering…';
  try {
    const r = await api('/api/restaurant/catalog/register-feed', { method: 'POST' });
    toast(r.updated ? '✅ Feed URL updated on Meta!' : '✅ Feed registered! Meta will sync daily.', 'ok');
    loadFeedStatus();
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '📡 Register Feed with Meta'; }
}


// Expose to window
window.loadWA = loadWA;
window.loadUsernameStatus = loadUsernameStatus;
window.loadMessagingStatus = loadMessagingStatus;
window.loadMessagingAnalytics = loadMessagingAnalytics;
window.provisionCatalog = provisionCatalog;
window.loadWATemplates = loadWATemplates;
window.renderTemplateTable = renderTemplateTable;
window.loadTemplateMappings = loadTemplateMappings;
window.onEventTemplateChange = onEventTemplateChange;
window.clearEventTemplate = clearEventTemplate;
window.saveTemplateMappings = saveTemplateMappings;
window.loadProfile = loadProfile;
window.saveProfile = saveProfile;
window.toggleDashGstHint = toggleDashGstHint;
window.updateDashDeliveryHint = updateDashDeliveryHint;
window.loadCatalogMgmt = loadCatalogMgmt;
window.toggleCatalogLink = toggleCatalogLink;
window.toggleCatalogCart = toggleCatalogCart;
window.toggleCatalogVisibility = toggleCatalogVisibility;
window.loadSyncLogs = loadSyncLogs;
window._setConnectBtns = _setConnectBtns;
window._showDashFallback = _showDashFallback;
window._doMetaConnect = _doMetaConnect;
window._finishMetaConnect = _finishMetaConnect;
window.loadIntegrations = loadIntegrations;
window.refreshIntTile = refreshIntTile;
window.renderIntLog = renderIntLog;
window.doToggleInt = doToggleInt;
window.openIntModal = openIntModal;
window.closeIntModal = closeIntModal;
window.doSaveIntegration = doSaveIntegration;
window.doSyncIntegration = doSyncIntegration;
window.doSyncPlatform = doSyncPlatform;
window.doRemoveIntegration = doRemoveIntegration;
window.showSyncResults = showSyncResults;
window.dismissSyncResults = dismissSyncResults;
window.openVariantModal = openVariantModal;
window.closeVariantModal = closeVariantModal;
window.snakeToCamel = snakeToCamel;
window.loadFeedStatus = loadFeedStatus;
window.doRegisterFeed = doRegisterFeed;
window.loadCatalogStatus = loadCatalogStatus;
window.loadCatalogDetails = loadCatalogDetails;
window.loadCatalogVisibility = loadCatalogVisibility;
window.loadCollectionStatus = loadCollectionStatus;
window.toggleCatalogAutoSync = toggleCatalogAutoSync;
window.doToggleCatalogVisibility = doToggleCatalogVisibility;
window.doCatalogCreate = doCatalogCreate;
window.doCatalogMerge = doCatalogMerge;
window.doCatalogSync = doCatalogSync;
window.doChangeCatalog = doChangeCatalog;
window.doReverseCatalogSync = doReverseCatalogSync;
window.doClearAndResync = doClearAndResync;
window.doEnableCommerceSettings = doEnableCommerceSettings;
window.doCatMgmtCreate = doCatMgmtCreate;
window.doCatMgmtCreateConfirm = doCatMgmtCreateConfirm;
window.doCatMgmtDelete = doCatMgmtDelete;
window.doCatMgmtDeleteConfirm = doCatMgmtDeleteConfirm;
window.doCatMgmtConnect = doCatMgmtConnect;
window.doCatMgmtConnectConfirm = doCatMgmtConnectConfirm;
window.doCatMgmtDisconnect = doCatMgmtDisconnect;
window.doCatMgmtSwitchCatalog = doCatMgmtSwitchCatalog;
window.doCatMgmtUpdateSettings = doCatMgmtUpdateSettings;
window.doSaveProfile = doSaveProfile;
window.doChangePassword = doChangePassword;
window.doDeleteAccount = doDeleteAccount;
window.doUpdateSlug = doUpdateSlug;
window.copyDashStoreUrl = copyDashStoreUrl;
window.copyWH = copyWH;
window.doSaveChargeConfig = doSaveChargeConfig;
window.doSaveNotifySettings = doSaveNotifySettings;
window.completeSetup = completeSetup;
window.checkAccountHealth = checkAccountHealth;
window.verifyMetaConnection = verifyMetaConnection;
window.doReconnectMeta = doReconnectMeta;
window.doBannerConnect = doBannerConnect;
window.renderEventMappings = renderEventMappings;
window.doBulkAssignAll = doBulkAssignAll;
window.doSyncBranchCollections = doSyncBranchCollections;
// ─── VIEW/EDIT MODE TOGGLE ──────────────────────────────
function toggleSettingsEdit(section, editMode) {
  var viewEl = document.getElementById('sec-' + section + '-view');
  var editEl = document.getElementById('sec-' + section + '-edit');
  var editBtn = document.getElementById('sec-' + section + '-edit-btn');
  if (viewEl) viewEl.style.display = editMode ? 'none' : 'block';
  if (editEl) editEl.style.display = editMode ? 'block' : 'none';
  if (editBtn) editBtn.style.display = editMode ? 'none' : 'inline-flex';
}

function _viewRow(label, value, opts) {
  opts = opts || {};
  var val = value || '<span style="color:var(--mute);font-style:italic">Not set</span>';
  var badge = opts.badge || '';
  var mono = opts.mono ? 'font-family:monospace;' : '';
  return '<div style="display:flex;justify-content:space-between;align-items:center;padding:.45rem 0;border-bottom:1px solid var(--rim,#f0f0f0)">'
    + '<span style="color:var(--dim);font-size:.78rem;min-width:130px">' + label + '</span>'
    + '<span style="font-weight:500;text-align:right;font-size:.84rem;' + mono + '">' + val + badge + '</span></div>';
}

function renderBizView(r) {
  var typeLabels = { both: 'Veg & Non-Veg', veg: 'Pure Veg', non_veg: 'Non-Veg Only' };
  var gstBadge = r.gst_verified ? ' <span style="font-size:.65rem;padding:.1rem .4rem;border-radius:99px;background:#dcfce7;color:#15803d;font-weight:700">\u2713 Verified</span>' : (r.gst_number ? ' <span style="font-size:.65rem;padding:.1rem .4rem;border-radius:99px;background:#fef3c7;color:#92400e;font-weight:600">Pending</span>' : '');
  var fssaiBadge = r.fssai_verified ? ' <span style="font-size:.65rem;padding:.1rem .4rem;border-radius:99px;background:#dcfce7;color:#15803d;font-weight:700">\u2713 Verified</span>' : (r.fssai_license ? ' <span style="font-size:.65rem;padding:.1rem .4rem;border-radius:99px;background:#fef3c7;color:#92400e;font-weight:600">Pending</span>' : '');
  var html = _viewRow('Brand Name', r.business_name) + _viewRow('Legal Name', r.registered_business_name) + _viewRow('Owner', r.owner_name) + _viewRow('Phone', r.phone) + _viewRow('Email', r.email) + _viewRow('City', r.city) + _viewRow('Type', typeLabels[r.restaurant_type] || r.restaurant_type);
  if (r.logo_url) html += _viewRow('Logo', '<img src="' + r.logo_url + '" style="height:28px;border-radius:4px">');
  html += '<p style="font-size:.82rem;font-weight:600;color:var(--dim);margin:.8rem 0 .4rem">Legal & Compliance</p>';
  html += _viewRow('GST Number', r.gst_number, { badge: gstBadge, mono: true }) + _viewRow('FSSAI License', r.fssai_license, { badge: fssaiBadge, mono: true });
  if (r.fssai_expiry) { var exp = new Date(r.fssai_expiry); var expStr = exp.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }); html += _viewRow('FSSAI Expiry', exp < new Date() ? '<span style="color:var(--red)">' + expStr + ' (EXPIRED)</span>' : expStr); }
  html += '<p style="font-size:.82rem;font-weight:600;color:var(--dim);margin:.8rem 0 .4rem">Store URL</p>';
  if (r.store_url) html += '<div style="display:flex;align-items:center;gap:.5rem;padding:.4rem .6rem;background:var(--ink2);border-radius:6px;margin-bottom:.3rem"><a href="' + r.store_url + '" target="_blank" style="flex:1;font-family:monospace;font-size:.8rem;color:var(--acc);word-break:break-all">' + r.store_url + '</a><button onclick="navigator.clipboard.writeText(\'' + r.store_url + '\');toast(\'Copied!\',\'ok\')" style="background:var(--wa);color:#fff;border:none;border-radius:5px;padding:.25rem .6rem;font-size:.72rem;font-weight:600;cursor:pointer">Copy</button></div>';
  else html += _viewRow('Store URL', null);
  html += '<p style="font-size:.82rem;font-weight:600;color:var(--dim);margin:.8rem 0 .4rem">Bank Account</p>';
  if (r.bank_name || r.bank_account_number) html += _viewRow('Bank', r.bank_name) + _viewRow('Account', r.bank_account_number ? '\u2022\u2022\u2022\u2022\u2022\u2022' + r.bank_account_number.slice(-4) : null) + _viewRow('IFSC', r.bank_ifsc, { mono: true });
  else html += '<div style="font-size:.8rem;color:var(--mute);font-style:italic;padding:.3rem 0">No bank details \u2014 add in Edit mode</div>';
  return html;
}

function renderPricingView(r) {
  var gstLabel = r.menu_gst_mode === 'included' ? 'Inclusive in prices' : 'Extra 5% at checkout';
  var delPct = r.delivery_fee_customer_pct != null ? r.delivery_fee_customer_pct : 100;
  var pkg = r.packaging_charge_rs || 0;
  var pkgGst = r.packaging_gst_pct != null ? r.packaging_gst_pct : 18;
  var box = function(label, val) { return '<div style="background:var(--ink2);border-radius:8px;padding:.65rem .8rem;text-align:center"><div style="font-size:.7rem;color:var(--dim);margin-bottom:.2rem">' + label + '</div><div style="font-size:.88rem;font-weight:600">' + val + '</div></div>'; };
  return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.8rem">'
    + box('GST Mode', gstLabel) + box('Delivery Split', delPct + '% customer / ' + (100 - delPct) + '% restaurant')
    + box('Packaging', pkg > 0 ? '\u20B9' + pkg + '/order' : 'Disabled') + box('Pkg GST', pkgGst + '%') + '</div>';
}

function renderNotifyView(r) {
  var phones = r.notification_phones && r.notification_phones.length ? r.notification_phones.join(', ') : '<span style="color:var(--mute);font-style:italic">Not configured</span>';
  var ns = r.notification_settings || {};
  var pill = function(on, label) { return '<span style="display:inline-flex;align-items:center;gap:.2rem;font-size:.72rem;font-weight:600;padding:.2rem .5rem;border-radius:99px;background:' + (on ? '#dcfce7' : 'var(--ink2)') + ';color:' + (on ? '#15803d' : 'var(--dim)') + '">' + (on ? '\u2705 ' : '') + label + '</span>'; };
  return _viewRow('Notification Phones', phones) + '<p style="font-size:.78rem;font-weight:600;color:var(--dim);margin:.5rem 0 .4rem">Events:</p><div style="display:flex;flex-wrap:wrap;gap:.4rem">'
    + pill(ns.new_order !== false, 'New Orders') + pill(ns.payment !== false, 'Payments') + pill(ns.cancelled !== false, 'Cancellations') + pill(!!ns.low_activity, 'Low Activity') + '</div>';
}

async function doSaveProfileAndClose() {
  await doSaveProfile();
  toggleSettingsEdit('biz', false);
  try { var r = await api('/auth/me'); if (r) { var v = document.getElementById('sec-biz-view'); if (v) v.innerHTML = renderBizView(r); } } catch(_){}
}
async function doSaveChargeConfigAndClose() {
  await doSaveChargeConfig();
  toggleSettingsEdit('pricing', false);
  try { var r = await api('/auth/me'); if (r) { var v = document.getElementById('sec-pricing-view'); if (v) v.innerHTML = renderPricingView(r); } } catch(_){}
}
async function doSaveNotifySettingsAndClose() {
  await doSaveNotifySettings();
  toggleSettingsEdit('notify', false);
  try { var r = await api('/auth/me'); if (r) { var v = document.getElementById('sec-notify-view'); if (v) v.innerHTML = renderNotifyView(r); } } catch(_){}
}

window.toggleSettingsEdit = toggleSettingsEdit;
window.doSaveProfileAndClose = doSaveProfileAndClose;
window.doSaveChargeConfigAndClose = doSaveChargeConfigAndClose;
window.doSaveNotifySettingsAndClose = doSaveNotifySettingsAndClose;
window.loadFeedList = loadFeedList;
window.doDeleteFeed = doDeleteFeed;
window.loadCatalogDiagnostics = loadCatalogDiagnostics;

})();
