// frontend/js/tabs/analytics.js
// Dashboard tab: Analytics + Customers + Ratings

(function() {

/* ─────────────────────────── ANALYTICS ─────────────────── */
var _anPeriod = '7d', _anGranularity = 'day';
var _anCharts = {};

function anSetPeriod(p, el) {
  _anPeriod = p;
  if (el) { document.querySelectorAll('#an-period-chips .chip').forEach(c => c.classList.remove('on')); el.classList.add('on'); }
  loadAnalytics();
}
function anSetGranularity(g, el) {
  _anGranularity = g;
  if (el) { el.closest('.chips').querySelectorAll('.chip').forEach(c => c.classList.remove('on')); el.classList.add('on'); }
  anLoadRevenue();
}

async function loadAnalytics() {
  await Promise.all([anLoadOverview(), anLoadRevenue(), anLoadTopItems(), anLoadPeakHours(), anLoadCustomers(), anLoadDelivery(), loadConversationAnalytics()]);
}

var _convosChart = null;
async function loadConversationAnalytics() {
  try {
    const d = await api('/api/restaurant/analytics/conversations');

    // Summary cards
    const el = (id) => document.getElementById(id);
    if (d.meta_analytics) {
      const m = d.meta_analytics;
      el('an-convos-total').textContent = m.total_conversations || 0;
      el('an-convos-service').textContent = m.categories?.service || 0;
      el('an-convos-utility').textContent = m.categories?.utility || 0;
      el('an-convos-marketing').textContent = m.categories?.marketing || 0;
    } else {
      el('an-convos-total').textContent = d.total_conversations_30d || 0;
      el('an-convos-service').textContent = '\u2014';
      el('an-convos-utility').textContent = '\u2014';
      el('an-convos-marketing').textContent = '\u2014';
    }

    // Active conversations
    const active = d.active_conversations || { count: 0, list: [] };
    el('an-active-count').textContent = `${active.count} active conversation${active.count !== 1 ? 's' : ''}`;
    el('an-active-list').innerHTML = active.list.length
      ? active.list.map(c => `<div style="display:flex;justify-content:space-between;padding:.3rem 0;border-bottom:1px solid var(--bdr)"><span>${c.phone}</span><span style="color:var(--dim)">${new Date(c.last_message_at).toLocaleTimeString()}</span><span class="badge ${c.direction === 'inbound' ? 'bg' : 'ba'}" style="font-size:.65rem">${c.direction === 'inbound' ? '\u2190 In' : '\u2192 Out'}</span></div>`).join('')
      : '<div style="color:var(--dim);padding:.5rem 0">No active conversations</div>';

    // Daily chart
    if (d.meta_analytics?.daily?.length) {
      const daily = d.meta_analytics.daily;
      const canvas = el('an-convos-chart');
      if (_convosChart) _convosChart.destroy();
      _convosChart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: daily.map(d => d.date.substring(5)),
          datasets: [
            { label: 'Service', data: daily.map(d => d.service || 0), backgroundColor: '#22c55e80', borderColor: '#22c55e', borderWidth: 1 },
            { label: 'Utility', data: daily.map(d => d.utility || 0), backgroundColor: '#3b82f680', borderColor: '#3b82f6', borderWidth: 1 },
            { label: 'Marketing', data: daily.map(d => d.marketing || 0), backgroundColor: '#a855f780', borderColor: '#a855f7', borderWidth: 1 },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } },
      });
    }
  } catch (e) {
    console.warn('[Analytics] Conversations load failed:', e.message);
  }
}

async function anLoadOverview() {
  try {
    const d = await api(`/api/restaurant/analytics/overview?period=${_anPeriod}`);
    if (!d) return;
    document.getElementById('an-total-orders').textContent = d.total_orders ?? 0;
    document.getElementById('an-total-revenue').textContent = '\u20B9' + Math.round(d.total_revenue_rs ?? 0).toLocaleString('en-IN');
    document.getElementById('an-avg-order').textContent = '\u20B9' + Math.round(d.avg_order_value_rs ?? 0);
    document.getElementById('an-total-customers').textContent = d.total_customers ?? 0;

    const fmtPct = (v) => { const cls = v >= 0 ? '' : ' dn'; return `<span class="stat-s${cls}">${v >= 0 ? '\u2191' : '\u2193'} ${Math.abs(v)}% vs prev period</span>`; };
    document.getElementById('an-orders-change').innerHTML = d.changes ? fmtPct(d.changes.orders_pct) : '';
    document.getElementById('an-revenue-change').innerHTML = d.changes ? fmtPct(d.changes.revenue_pct) : '';

    // Status breakdown pills
    const statusColors = { PENDING_PAYMENT:'#94a3b8', PAID:'#2563eb', CONFIRMED:'#7c3aed', PREPARING:'#d97706', PACKED:'#0891b2', DISPATCHED:'#4f46e5', DELIVERED:'#16a34a', CANCELLED:'#dc2626' };
    const sb = document.getElementById('an-status-breakdown');
    if (d.orders_by_status) {
      sb.innerHTML = Object.entries(d.orders_by_status).map(([s, c]) =>
        `<span style="display:inline-flex;align-items:center;gap:.35rem;padding:.3rem .7rem;border-radius:100px;font-size:.75rem;font-weight:500;background:${statusColors[s] || '#94a3b8'}15;color:${statusColors[s] || '#64748b'};border:1px solid ${statusColors[s] || '#94a3b8'}30">
          <span style="width:7px;height:7px;border-radius:50%;background:${statusColors[s] || '#94a3b8'}"></span>${s.replace(/_/g,' ')} (${c})
        </span>`
      ).join('');
    } else { sb.innerHTML = '<span style="color:var(--dim);font-size:.82rem">No data</span>'; }
  } catch (_) {}
}

async function anLoadRevenue() {
  try {
    const data = await api(`/api/restaurant/analytics/revenue?period=${_anPeriod}&granularity=${_anGranularity}`);
    if (!data || !data.length) { _destroyChart('revenue'); return; }

    const labels = data.map(d => d.date);
    const revenues = data.map(d => d.revenue_rs);
    const orders = data.map(d => d.order_count);

    _destroyChart('revenue');
    const ctx = document.getElementById('an-revenue-chart').getContext('2d');
    _anCharts.revenue = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'Revenue (\u20B9)', data: revenues, borderColor: '#4f46e5', backgroundColor: 'rgba(79,70,229,.1)', fill: true, tension: .3, yAxisID: 'y', pointRadius: 2 },
          { type: 'bar', label: 'Orders', data: orders, backgroundColor: 'rgba(22,163,74,.6)', borderRadius: 4, yAxisID: 'y1', barPercentage: .6 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { font: { size: 11 }, usePointStyle: true, pointStyleWidth: 10 } } },
        scales: {
          y:  { position: 'left', title: { display: true, text: 'Revenue (\u20B9)', font: { size: 11 } }, ticks: { callback: v => '\u20B9' + v.toLocaleString('en-IN') } },
          y1: { position: 'right', title: { display: true, text: 'Orders', font: { size: 11 } }, grid: { drawOnChartArea: false } },
          x:  { ticks: { font: { size: 10 }, maxRotation: 45 } },
        },
      },
    });
  } catch (_) {}
}

async function anLoadTopItems() {
  try {
    const data = await api(`/api/restaurant/analytics/top-items?period=${_anPeriod}&limit=10`);
    if (!data || !data.length) { _destroyChart('items'); return; }

    const labels = data.map(d => d.item_name);
    const qtys = data.map(d => d.total_quantity);
    const revs = data.map(d => d.total_revenue_rs);

    _destroyChart('items');
    const ctx = document.getElementById('an-items-chart').getContext('2d');
    _anCharts.items = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Quantity', data: qtys, backgroundColor: 'rgba(79,70,229,.7)', borderRadius: 4 },
          { label: 'Revenue (\u20B9)', data: revs, backgroundColor: 'rgba(217,119,6,.6)', borderRadius: 4 },
        ],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 }, usePointStyle: true, pointStyleWidth: 8 } } },
        scales: { x: { ticks: { font: { size: 10 } } }, y: { ticks: { font: { size: 10 } } } },
      },
    });
  } catch (_) {}
}

async function anLoadPeakHours() {
  try {
    const data = await api(`/api/restaurant/analytics/peak-hours?period=${_anPeriod}`);
    if (!data) return;

    // Hourly chart
    if (data.hours?.length) {
      _destroyChart('hours');
      const ctx = document.getElementById('an-hours-chart').getContext('2d');
      const fmtHour = h => h === 0 ? '12am' : h < 12 ? h + 'am' : h === 12 ? '12pm' : (h - 12) + 'pm';
      const maxVal = Math.max(...data.hours.map(h => h.order_count));
      const bgColors = data.hours.map(h => h.order_count >= maxVal * 0.8 ? 'rgba(220,38,38,.7)' : h.order_count >= maxVal * 0.5 ? 'rgba(217,119,6,.7)' : 'rgba(79,70,229,.5)');
      _anCharts.hours = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: data.hours.map(h => fmtHour(h.hour)),
          datasets: [{ label: 'Orders', data: data.hours.map(h => h.order_count), backgroundColor: bgColors, borderRadius: 3 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { ticks: { font: { size: 9 }, maxRotation: 90 } }, y: { beginAtZero: true, ticks: { stepSize: 1 } } },
        },
      });
    }

    // Day of week chart
    if (data.days?.length) {
      _destroyChart('days');
      const ctx2 = document.getElementById('an-days-chart').getContext('2d');
      const dayColors = ['#dc2626','#2563eb','#7c3aed','#d97706','#0891b2','#4f46e5','#16a34a'];
      _anCharts.days = new Chart(ctx2, {
        type: 'bar',
        data: {
          labels: data.days.map(d => d.day.slice(0, 3)),
          datasets: [{ label: 'Orders', data: data.days.map(d => d.order_count), backgroundColor: dayColors.slice(0, data.days.length), borderRadius: 6, barPercentage: .6 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
        },
      });
    }
  } catch (_) {}
}

async function anLoadCustomers() {
  try {
    const data = await api(`/api/restaurant/analytics/customers?period=${_anPeriod}`);
    if (!data) return;

    // Donut chart
    _destroyChart('custDonut');
    const ctx = document.getElementById('an-cust-donut').getContext('2d');
    _anCharts.custDonut = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['New', 'Returning'],
        datasets: [{ data: [data.new_customers, data.returning_customers], backgroundColor: ['#4f46e5', '#16a34a'], borderWidth: 0, cutout: '65%' }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, usePointStyle: true, padding: 12 } } } },
    });

    // Stats text
    document.getElementById('an-cust-stats').innerHTML = `
      <div><strong>${data.new_customers}</strong> new customers</div>
      <div><strong>${data.returning_customers}</strong> returning</div>
      <div>Repeat rate: <strong>${data.repeat_rate_pct}%</strong></div>
      <div>Avg orders/customer: <strong>${data.avg_orders_per_customer}</strong></div>`;

    // Top customers table
    const tbody = document.getElementById('an-top-cust');
    if (data.top_customers?.length) {
      tbody.innerHTML = data.top_customers.map(c =>
        `<tr><td>${c.name || '\u2014'}</td><td>${c.wa_phone || c.bsuid?.slice(0,12)+'\u2026' || '\u2014'}</td><td>${c.order_count}</td><td>\u20B9${Math.round(c.total_spent_rs).toLocaleString('en-IN')}</td></tr>`
      ).join('');
    } else { tbody.innerHTML = '<tr><td colspan="4" style="color:var(--dim);text-align:center">No data yet</td></tr>'; }
  } catch (_) {}
}

async function anLoadDelivery() {
  try {
    const data = await api(`/api/restaurant/analytics/delivery?period=${_anPeriod}`);
    if (!data) return;

    document.getElementById('an-avg-delivery').textContent = data.avg_delivery_time_min != null ? data.avg_delivery_time_min + ' min' : '\u2014';
    document.getElementById('an-avg-prep').textContent = data.avg_prep_time_min != null ? data.avg_prep_time_min + ' min' : '\u2014';
    document.getElementById('an-delivered-count').textContent = data.delivered_count ?? 0;

    const tbody = document.getElementById('an-branch-table');
    if (data.orders_by_branch?.length) {
      tbody.innerHTML = data.orders_by_branch.map(b =>
        `<tr><td>${b.branch_name}</td><td>${b.order_count}</td><td>\u20B9${Math.round(b.revenue_rs).toLocaleString('en-IN')}</td></tr>`
      ).join('');
    } else { tbody.innerHTML = '<tr><td colspan="3" style="color:var(--dim);text-align:center">No data yet</td></tr>'; }
  } catch (_) {}
}

function _destroyChart(key) {
  if (_anCharts[key]) { _anCharts[key].destroy(); _anCharts[key] = null; }
}

// Customers (debounceCustSearch, loadCustomers) and Ratings (loadRatings) are in restaurant.js

/* ─────────────────────────── DROP-OFF FUNNEL ─────────────── */
var _dfDays = 7;

async function loadDropoffAnalytics(days, el) {
  if (days) _dfDays = days;
  if (el) { document.querySelectorAll('#df-period-chips .chip').forEach(function(c) { c.classList.remove('on'); }); el.classList.add('on'); }

  var from = new Date(Date.now() - _dfDays * 86400000).toISOString();
  var to = new Date().toISOString();

  try {
    var data = await api('/api/restaurant/analytics/dropoffs?from=' + from + '&to=' + to + '&limit=50');
    renderDropoffCards(data.summary);
    renderFunnelBars(data.funnel);
    renderDropoffList(data.dropoffs || []);
  } catch (e) { console.warn('[Dropoff] Load failed:', e.message); }

  // Load recovery stats separately
  try {
    var stats = await api('/api/restaurant/analytics/recovery-stats?from=' + from + '&to=' + to);
    renderRecoveryStats(stats);
  } catch (_) {}
}

function renderDropoffCards(s) {
  document.getElementById('df-completion').textContent = s.completion_rate + '%';
  document.getElementById('df-cart-abandon').textContent = s.dropped_at_cart || '0';
  document.getElementById('df-pay-fail').textContent = s.payment_failed || '0';
  var recoverable = (s.dropped_at_cart || 0) + (s.dropped_at_payment || 0);
  document.getElementById('df-recoverable').textContent = recoverable;
}

function renderFunnelBars(funnel) {
  var el = document.getElementById('df-funnel');
  if (!funnel || !funnel.length) { el.innerHTML = '<p style="color:var(--dim);text-align:center;padding:1rem">No data for this period</p>'; return; }

  var colors = ['#94a3b8', '#3b82f6', '#8b5cf6', '#d97706', '#0891b2', '#16a34a'];
  var html = '';

  for (var i = 0; i < funnel.length; i++) {
    var f = funnel[i];
    var pct = Math.max(f.pct, 2); // min 2% width so label is visible
    var color = colors[i] || '#64748b';

    html += '<div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.35rem">';
    html += '<span style="width:110px;font-size:.78rem;font-weight:500;color:var(--dim);text-align:right;flex-shrink:0">' + f.stage + '</span>';
    html += '<div style="flex:1;background:var(--ink4,#f1f5f9);border-radius:6px;overflow:hidden;height:26px;position:relative">';
    html += '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:6px;transition:width .4s ease"></div>';
    html += '<span style="position:absolute;left:.6rem;top:50%;transform:translateY(-50%);font-size:.72rem;font-weight:600;color:' + (pct > 15 ? '#fff' : 'var(--tx)') + '">' + f.count + ' (' + f.pct + '%)</span>';
    html += '</div>';

    // Drop-off indicator between stages
    if (i < funnel.length - 1) {
      var drop = funnel[i].count - funnel[i + 1].count;
      var dropPct = funnel[i].count ? Math.round(drop / funnel[i].count * 100) : 0;
      if (drop > 0) {
        html += '</div>';
        html += '<div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.35rem">';
        html += '<span style="width:110px"></span>';
        html += '<span style="font-size:.68rem;color:#dc2626;padding-left:.4rem">\u2193 -' + dropPct + '% (' + drop + ' dropped)</span>';
      }
    }
    html += '</div>';
  }

  el.innerHTML = html;
}

function _maskPhone(phone) {
  if (!phone) return '\u2014';
  var s = String(phone);
  if (s.length <= 4) return s;
  return '\u2022\u2022\u2022\u2022' + s.slice(-4);
}

function renderDropoffList(list) {
  var tbody = document.getElementById('df-list-body');
  var countEl = document.getElementById('df-list-count');
  if (countEl) countEl.textContent = list.length + ' incomplete';

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--dim)">No abandoned sessions in this period</td></tr>';
    return;
  }

  var stageIcons = { initiated: '\uD83D\uDC4B', address: '\uD83D\uDCCD', browsing: '\uD83D\uDCCB', cart: '\uD83D\uDED2', payment_pending: '\uD83D\uDCB3', payment_failed: '\u274C' };
  var stageLabels = { initiated: 'Started', address: 'Address', browsing: 'Menu', cart: 'Cart', payment_pending: 'Payment', payment_failed: 'Failed' };

  tbody.innerHTML = list.map(function(d) {
    var icon = stageIcons[d.stage] || '\u2022';
    var label = stageLabels[d.stage] || d.stage;
    var cartVal = d.cart_total_rs ? '\u20B9' + Math.round(d.cart_total_rs) : '\u2014';
    var lastActive = d.hours_since_activity < 1 ? 'just now'
      : d.hours_since_activity < 24 ? Math.round(d.hours_since_activity) + 'h ago'
      : Math.round(d.hours_since_activity / 24) + 'd ago';
    var canRecover = (d.stage === 'cart' || d.stage === 'payment_pending') && d.hours_since_activity <= 48;
    var recoverBtn = canRecover
      ? '<button class="btn-p btn-sm" onclick="sendRecovery(\'' + d.conversation_id + '\',\'' + (d.customer_name || '').replace(/'/g, "\\'") + '\')" style="font-size:.72rem;padding:.25rem .6rem">Send Recovery</button>'
      : '<span style="color:var(--dim);font-size:.72rem">\u2014</span>';

    return '<tr style="border-bottom:1px solid var(--rim)">'
      + '<td style="padding:.5rem .7rem;font-weight:500">' + (d.customer_name || 'Unknown') + '</td>'
      + '<td style="padding:.5rem .7rem;font-family:monospace;font-size:.78rem;color:var(--dim)">' + _maskPhone(d.customer_phone) + '</td>'
      + '<td style="padding:.5rem .7rem;text-align:center"><span style="font-size:.72rem;padding:.2rem .5rem;border-radius:100px;background:var(--ink4)">' + icon + ' ' + label + '</span></td>'
      + '<td style="padding:.5rem .7rem;text-align:right;font-weight:500">' + cartVal + '</td>'
      + '<td style="padding:.5rem .7rem;text-align:right;font-size:.78rem;color:var(--dim)">' + lastActive + '</td>'
      + '<td style="padding:.5rem .7rem;text-align:center">' + recoverBtn + '</td>'
      + '</tr>';
  }).join('');
}

async function sendRecovery(conversationId, customerName) {
  if (!confirm('Send a recovery message to ' + (customerName || 'this customer') + '? This will use a WhatsApp message.')) return;
  try {
    var result = await api('/api/restaurant/dropoffs/' + conversationId + '/recover', { method: 'POST' });
    if (result.success) {
      toast('Recovery message sent!', 'ok');
      loadDropoffAnalytics(); // refresh the list
    }
  } catch (err) {
    toast(err.message || 'Failed to send recovery message', 'err');
  }
}

function renderRecoveryStats(stats) {
  var el = document.getElementById('df-recovery-stats');
  if (!stats || !stats.total_sent) {
    el.innerHTML = '<span style="color:var(--dim)">No recovery messages sent yet. Use the "Send Recovery" button above to win back abandoned carts.</span>';
    return;
  }
  el.innerHTML = '<div style="display:flex;gap:2rem;flex-wrap:wrap">'
    + '<div><span style="font-weight:700;font-size:1.1rem">' + stats.total_sent + '</span> <span style="color:var(--dim)">messages sent</span></div>'
    + '<div><span style="font-weight:700;font-size:1.1rem;color:var(--wa)">' + stats.recovered + '</span> <span style="color:var(--dim)">orders recovered</span></div>'
    + '<div><span style="font-weight:700;font-size:1.1rem">' + stats.recovery_rate + '%</span> <span style="color:var(--dim)">conversion rate</span></div>'
    + '</div>';
}

// Expose to window for inline onclick handlers
window.anSetPeriod = anSetPeriod;
window.anSetGranularity = anSetGranularity;
window.loadAnalytics = loadAnalytics;
window.loadConversationAnalytics = loadConversationAnalytics;
window.anLoadOverview = anLoadOverview;
window.anLoadRevenue = anLoadRevenue;
window.anLoadTopItems = anLoadTopItems;
window.anLoadPeakHours = anLoadPeakHours;
window.anLoadDelivery = anLoadDelivery;
window.anLoadCustomers = anLoadCustomers;
// ─── CART RECOVERY ANALYTICS ─────────────────────────────
async function loadCartRecoveryStats() {
  const period = document.getElementById('cr-period')?.value || '7d';
  try {
    const d = await api(`/api/restaurant/analytics/cart-recovery?period=${period}`);
    document.getElementById('cr-abandoned').textContent = d.total_abandoned || 0;
    document.getElementById('cr-recovered').textContent = d.total_recovered || 0;
    document.getElementById('cr-rate').textContent = (d.recovery_rate || 0) + '%';
    document.getElementById('cr-revenue').textContent = '₹' + (d.revenue_recovered || 0).toLocaleString('en-IN');

    // Funnel by stage
    const stages = d.by_stage || {};
    const funnelEl = document.getElementById('cr-funnel');
    if (funnelEl) {
      const rows = ['address_pending', 'review_pending', 'payment_pending', 'payment_failed']
        .map(s => {
          const st = stages[s] || { abandoned: 0, recovered: 0 };
          const label = { address_pending: '📍 Address', review_pending: '🛒 Review', payment_pending: '💳 Payment', payment_failed: '❌ Failed' }[s] || s;
          const pct = st.abandoned ? Math.round(st.recovered / st.abandoned * 100) : 0;
          return `<div style="display:flex;align-items:center;gap:.6rem;padding:.35rem 0;border-bottom:1px solid var(--bdr,#e5e7eb)"><span style="width:100px">${label}</span><span style="flex:1"><div style="height:6px;background:var(--rim,#e5e7eb);border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--wa);border-radius:3px"></div></div></span><span style="width:70px;text-align:right;font-size:.76rem">${st.recovered}/${st.abandoned}</span></div>`;
        }).join('');
      funnelEl.innerHTML = rows || '<div style="color:var(--dim)">No data yet</div>';
    }

    // Reminders breakdown
    const rem = d.by_reminder || {};
    const remLines = [1, 2, 3].map(r => {
      const rd = rem[`reminder_${r}`] || { sent: 0, recovered: 0 };
      return rd.sent ? `R${r}: ${rd.sent} sent → ${rd.recovered} recovered` : null;
    }).filter(Boolean);
    if (remLines.length && funnelEl) {
      funnelEl.innerHTML += `<div style="margin-top:.6rem;font-size:.76rem;color:var(--dim)">${remLines.join(' · ')}</div>`;
    }
  } catch (e) {
    const funnelEl = document.getElementById('cr-funnel');
    if (funnelEl) funnelEl.innerHTML = '<div style="color:var(--dim)">Failed to load cart recovery data</div>';
  }
}

window._destroyChart = _destroyChart;
window.loadDropoffAnalytics = loadDropoffAnalytics;
window.sendRecovery = sendRecovery;
window.loadCartRecoveryStats = loadCartRecoveryStats;

})();
