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
window._destroyChart = _destroyChart;

})();
