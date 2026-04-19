// frontend/js/tabs/messages.js
// Dashboard tab: Messages Inbox + Issues

(function() {

let msgFilter = 'all', msgSearch = '', msgThreads = [], msgActiveCust = null, msgPollTimer = null, msgThreadPollTimer = null, _lastUnreadCount = 0;

async function loadMessages() {
  msgActiveCust = null;
  clearInterval(msgThreadPollTimer);
  document.getElementById('msg-thread-header').style.display = 'none';
  document.getElementById('msg-reply-bar').style.display = 'none';
  document.getElementById('msg-thread-body').innerHTML = '<div style="text-align:center;color:var(--dim);padding:3rem 0;font-size:.85rem">Select a conversation to view messages</div>';
  await fetchThreads();
}

async function fetchThreads() {
  const list = document.getElementById('msg-thread-list');
  try {
    const qs = new URLSearchParams();
    if (msgFilter && msgFilter !== 'all') qs.set('status', msgFilter);
    if (msgSearch) qs.set('search', msgSearch);
    const r = await api('/api/restaurant/messages?' + qs);
    msgThreads = r.threads || [];
    if (!msgThreads.length) {
      list.innerHTML = '<div style="text-align:center;color:var(--dim);padding:2rem .5rem;font-size:.82rem">No conversations found</div>';
      return;
    }
    list.innerHTML = msgThreads.map(t => {
      const unread = t.unread_count || 0;
      const active = msgActiveCust === t.customer_id;
      const lastMsg = t.last_message_text || (t.last_message_type && t.last_message_type !== 'text' ? '📎 ' + t.last_message_type : '');
      const preview = lastMsg.length > 60 ? lastMsg.slice(0, 60) + '…' : lastMsg;
      return `<div onclick="loadMsgThread('${t.customer_id}')" style="padding:.6rem .7rem;border-radius:8px;cursor:pointer;border:1px solid ${active ? 'var(--wa)' : 'transparent'};background:${active ? 'rgba(37,211,102,.08)' : 'transparent'};transition:all .15s" onmouseover="this.style.background='var(--ink3)'" onmouseout="this.style.background='${active ? 'rgba(37,211,102,.08)' : 'transparent'}'">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:${unread ? '700' : '500'};font-size:.84rem">${_esc(t.customer_name || t.customer_phone || 'Unknown')}</span>
          <span style="font-size:.68rem;color:var(--dim)">${t.last_message_at ? timeAgo(t.last_message_at) : ''}</span>
        </div>
        <div style="font-size:.76rem;color:var(--dim);margin-top:.15rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(preview)}</div>
        ${unread ? `<span style="display:inline-block;margin-top:.25rem;background:var(--wa);color:#fff;font-size:.6rem;padding:.1rem .4rem;border-radius:9px;font-weight:600">${unread} new</span>` : ''}
        ${t.has_active_order ? '<span style="display:inline-block;margin-top:.25rem;margin-left:.3rem;font-size:.6rem;padding:.1rem .4rem;border-radius:9px;background:var(--gold);color:#000;font-weight:600">Active Order</span>' : ''}
      </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div style="padding:1rem;color:var(--red);font-size:.82rem">Failed to load: ${e.message}</div>`;
  }
}

function renderMsgBubble(m) {
  const isInbound = m.direction === 'inbound';
  const align = isInbound ? 'flex-start' : 'flex-end';
  const bg = isInbound ? 'var(--ink3)' : 'rgba(37,211,102,.15)';
  const border = isInbound ? '' : 'border:1px solid rgba(37,211,102,.3);';
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const type = m.message_type || 'text';
  let content = '';

  if (type === 'image') {
    const mediaId = m.media_id;
    content = `<div class="msg-media-img" data-media-id="${mediaId}" style="margin-bottom:.3rem;cursor:pointer" onclick="openMsgMedia('${mediaId}')">
      <div style="width:200px;height:140px;background:var(--ink2);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:2rem">📷</div>
    </div>`;
    if (m.caption) content += `<div>${m.caption}</div>`;
    if (mediaId) fetchMsgMediaThumb(mediaId);
  } else if (type === 'document') {
    content = `<div style="display:flex;align-items:center;gap:.4rem;cursor:pointer" onclick="openMsgMedia('${m.media_id}')"><span style="font-size:1.1rem">📎</span><span>${m.caption || 'Document'}</span></div>`;
  } else if (type === 'location') {
    content = '📍 Location shared';
  } else if (type === 'sticker') {
    content = '🏷️ Sticker';
  } else {
    content = m.text || '';
  }

  return `<div style="align-self:${align};max-width:75%;padding:.5rem .7rem;border-radius:12px;background:${bg};${border}font-size:.83rem;line-height:1.45">
    <div>${content}</div>
    <div style="font-size:.62rem;color:var(--dim);text-align:right;margin-top:.2rem">${time}${!isInbound ? ' · ' + (m.status || 'sent') : ''}</div>
  </div>`;
}

async function fetchMsgMediaThumb(mediaId) {
  try {
    const r = await api('/api/restaurant/messages/media/' + mediaId);
    if (!r.url) return;
    const el = document.querySelector(`.msg-media-img[data-media-id="${mediaId}"]`);
    if (el) el.innerHTML = `<img src="${r.url}" style="max-width:200px;max-height:200px;border-radius:8px;object-fit:cover;cursor:pointer" onclick="window.open(this.src,'_blank')" onerror="this.style.display='none';this.parentElement.innerHTML='<span style=&quot;font-size:.78rem;color:var(--dim)&quot;>📷 Image unavailable</span>'">`;
  } catch (_) {}
}

async function openMsgMedia(mediaId) {
  try {
    const r = await api('/api/restaurant/messages/media/' + mediaId);
    if (r.url) window.open(r.url, '_blank');
  } catch (e) { toast('Could not load media', 'err'); }
}

async function loadMsgThread(customerId) {
  msgActiveCust = customerId;
  clearInterval(msgThreadPollTimer);
  const header = document.getElementById('msg-thread-header');
  const body = document.getElementById('msg-thread-body');
  const replyBar = document.getElementById('msg-reply-bar');
  const warning = document.getElementById('msg-window-warning');

  body.innerHTML = '<div class="spin" style="margin:2rem auto;display:block;width:22px;height:22px"></div>';
  header.style.display = 'block';

  try {
    const r = await api('/api/restaurant/messages/thread/' + customerId);
    const msgs = r.messages || [];
    const thread = msgThreads.find(t => t.customer_id === customerId) || {};

    document.getElementById('msg-thread-name').textContent = thread.customer_name || thread.customer_phone || 'Customer';
    document.getElementById('msg-thread-info').textContent = thread.customer_phone || '';
    document.getElementById('msg-resolve-btn').style.display = thread.status === 'resolved' ? 'none' : '';

    // Check 24h window
    const lastInbound = msgs.filter(m => m.direction === 'inbound').pop();
    const windowOpen = lastInbound && (Date.now() - new Date(lastInbound.created_at).getTime()) < 24 * 60 * 60 * 1000;
    warning.style.display = windowOpen ? 'none' : 'block';
    replyBar.style.display = 'flex';
    document.getElementById('msg-reply-input').disabled = !windowOpen;

    if (!msgs.length) {
      body.innerHTML = '<div style="text-align:center;color:var(--dim);padding:2rem 0;font-size:.82rem">No messages in this thread</div>';
    } else {
      body.innerHTML = msgs.map(renderMsgBubble).join('');
      body.scrollTop = body.scrollHeight;
    }
    // Refresh thread list to update unread counts
    fetchThreads();

    // Start 15-second thread polling
    msgThreadPollTimer = setInterval(() => refreshActiveThread(), 15000);
  } catch (e) {
    body.innerHTML = `<div style="padding:1rem;color:var(--red);font-size:.82rem">Error: ${e.message}</div>`;
  }
}

async function refreshActiveThread() {
  if (!msgActiveCust) return;
  try {
    const r = await api('/api/restaurant/messages/thread/' + msgActiveCust);
    const msgs = r.messages || [];
    const body = document.getElementById('msg-thread-body');
    const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    body.innerHTML = msgs.map(renderMsgBubble).join('');
    if (wasAtBottom) body.scrollTop = body.scrollHeight;

    // Update 24h window
    const lastInbound = msgs.filter(m => m.direction === 'inbound').pop();
    const windowOpen = lastInbound && (Date.now() - new Date(lastInbound.created_at).getTime()) < 24 * 60 * 60 * 1000;
    document.getElementById('msg-window-warning').style.display = windowOpen ? 'none' : 'block';
    document.getElementById('msg-reply-input').disabled = !windowOpen;
  } catch (_) {}
}

async function sendMsgReply() {
  const input = document.getElementById('msg-reply-input');
  const text = input.value.trim();
  if (!text || !msgActiveCust) return;
  input.disabled = true;
  try {
    await api('/api/restaurant/messages/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: msgActiveCust, text })
    });
    input.value = '';
    refreshActiveThread();
    fetchThreads();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function resolveThread() {
  if (!msgActiveCust) return;
  try {
    await api('/api/restaurant/messages/thread/' + msgActiveCust + '/resolve', { method: 'PUT' });
    toast('Thread resolved', 'ok');
    document.getElementById('msg-resolve-btn').style.display = 'none';
    fetchThreads();
  } catch (e) { toast(e.message, 'err'); }
}

function setMsgFilter(f, btn) {
  msgFilter = f;
  document.querySelectorAll('.msg-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  fetchThreads();
}

let _msgSearchTimer;
function debounceMsgSearch() {
  clearTimeout(_msgSearchTimer);
  _msgSearchTimer = setTimeout(() => {
    msgSearch = document.getElementById('msg-search').value.trim();
    fetchThreads();
  }, 350);
}

function createIssueFromThread() {
  if (!msgActiveCust) return;
  const thread = msgThreads.find(t => t.customer_id === msgActiveCust) || {};
  openCreateIssue(msgActiveCust, thread.related_order_id || '', thread.last_message_text || '');
}

function startMsgPoll() {
  clearInterval(msgPollTimer);
  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  // Initial unread count fetch (WebSocket handles subsequent updates)
  (async () => {
    try {
      const r = await api('/api/restaurant/messages/unread-count');
      const badge = document.getElementById('msg-badge');
      const newCount = r.count || 0;
      if (newCount > 0) { badge.textContent = newCount; badge.style.display = ''; }
      else { badge.style.display = 'none'; }
      _lastUnreadCount = newCount;
    } catch {}
  })();
  // Fallback poll only when WebSocket is not connected (30s interval)
  msgPollTimer = setInterval(async () => {
    if (_ws && _ws.readyState === WebSocket.OPEN) return; // WS is live, skip poll
    try {
      const r = await api('/api/restaurant/messages/unread-count');
      const badge = document.getElementById('msg-badge');
      const newCount = r.count || 0;
      if (newCount > 0) { badge.textContent = newCount; badge.style.display = ''; }
      else { badge.style.display = 'none'; }
      _lastUnreadCount = newCount;
    } catch (e) {
      if (e.message?.includes('401') || e.message?.includes('403')) { clearInterval(msgPollTimer); return; }
    }
  }, 30000);
}


let issFilter = 'open_all', issPage = 1, issActiveIssue = null;
const ISS_PRI_CLR = { critical: '#dc2626', high: '#f59e0b', medium: '#3b82f6', low: '#94a3b8' };
const ISS_PRI_BG  = { critical: 'rgba(220,38,38,.1)', high: 'rgba(245,158,11,.1)', medium: 'rgba(59,130,246,.08)', low: 'rgba(148,163,184,.08)' };
const ISS_ST_CLR  = { open: '#3b82f6', assigned: '#8b5cf6', in_progress: '#f59e0b', waiting_customer: '#6366f1', escalated_to_admin: '#dc2626', resolved: '#16a34a', closed: '#64748b', reopened: '#ef4444' };

async function loadIssues() {
  await Promise.all([loadIssueStats(), loadIssueList()]);
}

async function loadIssueStats() {
  try {
    const s = await api('/api/restaurant/issues/stats');
    document.getElementById('iss-stats').innerHTML = [
      issStat('Open', s.open, '#3b82f6'),
      issStat('In Progress', s.in_progress, '#f59e0b'),
      issStat('Escalated', s.escalated, '#dc2626'),
      issStat('Resolved', s.resolved, '#16a34a'),
      issStat('SLA Breached', s.sla_breached, s.sla_breached > 0 ? '#dc2626' : '#94a3b8'),
    ].join('');
    // Update sidebar badge
    const badge = document.getElementById('issue-badge');
    const openCount = (s.open || 0) + (s.in_progress || 0);
    if (openCount > 0) { badge.textContent = openCount; badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  } catch (_) {}
}

function issStat(label, val, clr) {
  return `<div style="background:var(--ink2);border:1px solid var(--rim);border-radius:10px;padding:.7rem .8rem">
    <div style="font-size:.65rem;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;font-weight:600">${label}</div>
    <div style="font-size:1.4rem;font-weight:700;color:${clr}">${val || 0}</div>
  </div>`;
}

async function loadIssueList(page) {
  if (page) issPage = page;
  const tbody = document.getElementById('iss-tbody');
  tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--dim);padding:2rem">Loading…</td></tr>';
  try {
    const qs = new URLSearchParams({ page: issPage, limit: 20 });
    if (issFilter) qs.set('status', issFilter);
    const cat = document.getElementById('iss-cat-filter').value;
    if (cat) qs.set('category', cat);
    const search = document.getElementById('iss-search').value.trim();
    if (search) qs.set('search', search);
    const r = await api('/api/restaurant/issues?' + qs);
    const issues = r.issues || [];
    if (!issues.length) { tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--dim);padding:2rem">No issues found</td></tr>'; return; }
    tbody.innerHTML = issues.map(i => {
      const sla = slaLabel(i);
      const priClr = ISS_PRI_CLR[i.priority] || '#94a3b8';
      const stClr = ISS_ST_CLR[i.status] || '#64748b';
      return `<tr style="cursor:pointer" onclick="openIssDetail('${i._id}')">
        <td style="font-weight:600;font-size:.8rem;white-space:nowrap">${i.issue_number}</td>
        <td style="font-size:.78rem">${catLabel(i.category)}</td>
        <td style="font-size:.8rem">${i.customer_name || '—'}</td>
        <td style="font-size:.78rem;color:var(--dim)">${i.order_number || '—'}</td>
        <td><span style="color:${priClr};font-weight:600;font-size:.72rem;text-transform:uppercase">${i.priority}</span></td>
        <td><span style="background:${stClr};color:#fff;font-size:.68rem;padding:.12rem .4rem;border-radius:4px;font-weight:600">${i.status.replace(/_/g,' ')}</span></td>
        <td style="font-size:.72rem">${sla}</td>
        <td style="font-size:.72rem;color:var(--dim)">${timeAgo(i.created_at)}</td>
        <td><button class="btn-g btn-sm" style="font-size:.7rem;padding:.15rem .4rem" onclick="event.stopPropagation();openIssDetail('${i._id}')">View</button></td>
      </tr>`;
    }).join('');
    // Pager
    const pager = document.getElementById('iss-pager');
    if (r.pages > 1) {
      let h = '';
      if (r.page > 1) h += `<button class="btn-g btn-sm" onclick="loadIssueList(${r.page-1})">« Prev</button>`;
      h += `<span style="font-size:.78rem;color:var(--dim);padding:.3rem .5rem">Page ${r.page} of ${r.pages}</span>`;
      if (r.page < r.pages) h += `<button class="btn-g btn-sm" onclick="loadIssueList(${r.page+1})">Next »</button>`;
      pager.innerHTML = h;
    } else pager.innerHTML = '';
  } catch (e) { tbody.innerHTML = `<tr><td colspan="9" style="color:var(--red);padding:1rem">${e.message}</td></tr>`; }
}

function catLabel(cat) {
  const map = { food_quality:'🍕 Food Quality', missing_item:'📦 Missing Item', wrong_order:'❌ Wrong Order', portion_size:'📏 Portion', packaging:'📦 Packaging', hygiene:'🧹 Hygiene', delivery_late:'🕐 Late', delivery_not_received:'🚫 Not Received', delivery_damaged:'💥 Damaged', rider_behavior:'🛵 Rider', wrong_address:'📍 Wrong Addr', wrong_charge:'💸 Wrong Charge', refund_request:'💰 Refund', payment_failed:'⚠️ Payment', coupon_issue:'🏷️ Coupon', general:'💬 General', app_issue:'📱 App' };
  return map[cat] || cat;
}

function slaLabel(issue) {
  if (['resolved','closed'].includes(issue.status)) return '<span style="color:#16a34a">✓</span>';
  if (!issue.sla_deadline) return '—';
  const remaining = new Date(issue.sla_deadline).getTime() - Date.now();
  if (remaining <= 0) return '<span style="color:#dc2626;font-weight:600">🔴 Breached</span>';
  const hrs = Math.floor(remaining / 3600000);
  const mins = Math.floor((remaining % 3600000) / 60000);
  if (remaining < 3600000) return `<span style="color:#dc2626">🟡 ${mins}m left</span>`;
  if (hrs < 6) return `<span style="color:#f59e0b">🟡 ${hrs}h ${mins}m</span>`;
  return `<span style="color:#16a34a">🟢 ${hrs}h</span>`;
}

function setIssFilter(f, btn) {
  issFilter = f; issPage = 1;
  document.querySelectorAll('.iss-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadIssueList();
}

let _issSearchTimer;
function debounceIssSearch() {
  clearTimeout(_issSearchTimer);
  _issSearchTimer = setTimeout(() => { issPage = 1; loadIssueList(); }, 400);
}

async function openIssDetail(id) {
  issActiveIssue = id;
  document.getElementById('iss-detail').style.display = 'block';
  try {
    const i = await api('/api/restaurant/issues/' + id);
    document.getElementById('iss-d-number').textContent = i.issue_number;
    document.getElementById('iss-d-category').textContent = catLabel(i.category);
    const priClr = ISS_PRI_CLR[i.priority] || '#94a3b8';
    const priBg = ISS_PRI_BG[i.priority] || '';
    document.getElementById('iss-d-priority').style.cssText = `font-size:.72rem;font-weight:700;padding:.12rem .4rem;border-radius:4px;background:${priBg};color:${priClr};text-transform:uppercase`;
    document.getElementById('iss-d-priority').textContent = i.priority;
    const stClr = ISS_ST_CLR[i.status] || '#64748b';
    document.getElementById('iss-d-status').style.cssText = `font-size:.72rem;font-weight:600;padding:.12rem .4rem;border-radius:4px;background:${stClr};color:#fff`;
    document.getElementById('iss-d-status').textContent = i.status.replace(/_/g, ' ');
    document.getElementById('iss-d-sla').innerHTML = slaLabel(i);
    document.getElementById('iss-d-cust').textContent = i.customer_name || 'Unknown';
    document.getElementById('iss-d-phone').textContent = i.customer_phone || '—';
    document.getElementById('iss-d-order').textContent = i.order_number || '—';
    document.getElementById('iss-d-desc').textContent = i.description || '';

    // Media
    const mediaEl = document.getElementById('iss-d-media');
    mediaEl.innerHTML = (i.media || []).map(m => {
      if (m.media_type === 'image') return `<div style="width:80px;height:80px;background:var(--ink3);border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer" onclick="openMsgMedia('${m.media_id}')">📷</div>`;
      return `<span style="font-size:.78rem;color:var(--dim)">${_esc(m.media_type)}: ${_esc(m.media_id)}</span>`;
    }).join('');

    // Messages thread
    const msgsEl = document.getElementById('iss-d-msgs');
    msgsEl.innerHTML = (i.messages || []).map(m => {
      const isCust = m.sender_type === 'customer';
      const isSys = m.sender_type === 'system';
      if (isSys) return `<div style="text-align:center;font-size:.72rem;color:var(--dim);padding:.2rem 0">${_esc(m.text)}</div>`;
      const align = isCust ? 'flex-start' : 'flex-end';
      const bg = isCust ? 'var(--ink3)' : m.internal ? 'rgba(139,92,246,.1)' : 'rgba(37,211,102,.12)';
      const border = m.internal ? 'border:1px dashed rgba(139,92,246,.3);' : '';
      const time = new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<div style="align-self:${align};max-width:80%;padding:.4rem .6rem;border-radius:10px;background:${bg};${border}font-size:.82rem;line-height:1.4">
        <div style="font-size:.65rem;font-weight:600;color:var(--dim);margin-bottom:.15rem">${_esc(m.sender_name)}${m.internal ? ' (internal)' : ''}</div>
        <div>${_esc(m.text)}</div>
        <div style="font-size:.6rem;color:var(--dim);text-align:right;margin-top:.15rem">${time}</div>
      </div>`;
    }).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;

    // Action buttons
    const acts = document.getElementById('iss-d-actions');
    let btns = '';
    if (['open','reopened'].includes(i.status)) btns += `<button class="btn-p btn-sm" onclick="issAction('assigned')">Assign to me</button>`;
    if (['open','assigned','reopened'].includes(i.status)) btns += `<button class="btn-p btn-sm" onclick="issAction('in_progress')">Mark In Progress</button>`;
    if (!['resolved','closed'].includes(i.status)) {
      btns += `<button class="btn-g btn-sm" style="color:#dc2626;border-color:#dc2626" onclick="issEscalate()">Escalate to GullyBite</button>`;
      btns += `<button class="btn-g btn-sm" style="color:#16a34a;border-color:#16a34a" onclick="issResolve()">Resolve</button>`;
    }
    if (i.status === 'resolved') btns += `<button class="btn-g btn-sm" onclick="issAction('reopened')">Reopen</button>`;
    acts.innerHTML = btns;
  } catch (e) { toast(e.message, 'err'); }
}

function closeIssDetail() { document.getElementById('iss-detail').style.display = 'none'; issActiveIssue = null; }

async function issAction(status) {
  if (!issActiveIssue) return;
  try {
    if (status === 'reopened') {
      await api('/api/restaurant/issues/' + issActiveIssue + '/reopen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    } else {
      await api('/api/restaurant/issues/' + issActiveIssue + '/status', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    }
    toast('Status updated', 'ok');
    openIssDetail(issActiveIssue);
    loadIssueList();
    loadIssueStats();
  } catch (e) { toast(e.message, 'err'); }
}

async function sendIssMsg() {
  const input = document.getElementById('iss-d-reply');
  const text = input.value.trim();
  if (!text || !issActiveIssue) return;
  const internal = document.getElementById('iss-d-internal').checked;
  input.disabled = true;
  try {
    await api('/api/restaurant/issues/' + issActiveIssue + '/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, internal })
    });
    input.value = '';
    document.getElementById('iss-d-internal').checked = false;
    openIssDetail(issActiveIssue);
  } catch (e) { toast(e.message, 'err'); }
  finally { input.disabled = false; input.focus(); }
}

function issEscalate() {
  const reason = prompt('Reason for escalation to GullyBite admin:');
  if (!reason) return;
  api('/api/restaurant/issues/' + issActiveIssue + '/escalate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason })
  }).then(() => { toast('Issue escalated to admin', 'ok'); openIssDetail(issActiveIssue); loadIssueList(); loadIssueStats(); })
    .catch(e => toast(e.message, 'err'));
}

function issResolve() {
  const resolutionType = prompt('Resolution type:\nfull_refund, partial_refund, credit, replacement, redelivery, apology, explanation, no_action');
  if (!resolutionType) return;
  const notes = prompt('Resolution notes (optional):') || '';
  api('/api/restaurant/issues/' + issActiveIssue + '/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolution_type: resolutionType, resolution_notes: notes })
  }).then(() => { toast('Issue resolved', 'ok'); openIssDetail(issActiveIssue); loadIssueList(); loadIssueStats(); })
    .catch(e => toast(e.message, 'err'));
}

// Create issue from inbox
function openCreateIssue(customerId, orderId, description) {
  document.getElementById('iss-c-cust').value = customerId || '';
  document.getElementById('iss-c-order').value = orderId || '';
  document.getElementById('iss-c-desc').value = description || '';
  document.getElementById('iss-c-cat').value = 'general';
  document.getElementById('iss-create-modal').style.display = 'block';
}

async function doCreateIssue() {
  const custId = document.getElementById('iss-c-cust').value.trim();
  const orderId = document.getElementById('iss-c-order').value.trim();
  const cat = document.getElementById('iss-c-cat').value;
  const desc = document.getElementById('iss-c-desc').value.trim();
  if (!custId || !desc) { toast('Customer and description required', 'err'); return; }
  try {
    const issue = await api('/api/restaurant/issues', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: custId, order_id: orderId || undefined, category: cat, description: desc })
    });
    toast('Issue ' + issue.issue_number + ' created', 'ok');
    document.getElementById('iss-create-modal').style.display = 'none';
    goTab('issues', document.querySelector('[onclick*="issues"]'));
  } catch (e) { toast(e.message, 'err'); }
}


// Expose to window
window.loadMessages = loadMessages;
window.fetchThreads = fetchThreads;
window.renderMsgBubble = renderMsgBubble;
window.fetchMsgMediaThumb = fetchMsgMediaThumb;
window.openMsgMedia = openMsgMedia;
window.loadMsgThread = loadMsgThread;
window.refreshActiveThread = refreshActiveThread;
window.sendMsgReply = sendMsgReply;
window.resolveThread = resolveThread;
window.setMsgFilter = setMsgFilter;
window.debounceMsgSearch = debounceMsgSearch;
window.createIssueFromThread = createIssueFromThread;
window.startMsgPoll = startMsgPoll;
window.loadIssues = loadIssues;
window.loadIssueStats = loadIssueStats;
window.loadIssueList = loadIssueList;
window.catLabel = catLabel;
window.slaLabel = slaLabel;
window.setIssFilter = setIssFilter;
window.debounceIssSearch = debounceIssSearch;
window.openIssDetail = openIssDetail;
window.closeIssDetail = closeIssDetail;
window.issAction = issAction;
window.sendIssMsg = sendIssMsg;
window.issEscalate = issEscalate;
window.issResolve = issResolve;
window.openCreateIssue = openCreateIssue;
window.doCreateIssue = doCreateIssue;
window.issStat = issStat;

})();
