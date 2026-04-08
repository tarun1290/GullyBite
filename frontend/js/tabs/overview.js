// frontend/js/tabs/overview.js
// Dashboard tab: Overview

(function() {

async function loadOverview() {
  // Render setup wizard — auto-hides itself when all steps complete
  renderWizard().catch(() => {});
  try {
    const [d1, d7] = await Promise.all([
      api('/api/restaurant/analytics?days=1'),
      api('/api/restaurant/analytics?days=7'),
    ]);
    document.getElementById('st-tod').textContent = d1?.summary?.total_orders ?? 0;
    document.getElementById('st-rev').textContent = '₹' + Math.round(d1?.summary?.total_revenue ?? 0);
    document.getElementById('st-wk').textContent  = d7?.summary?.total_orders ?? 0;
    document.getElementById('st-act').textContent = '—';
    loadRecent();
    loadOverviewCharts();
  } catch (_) {}
}

async function loadOverviewCharts() {
  if (typeof Chart === 'undefined') return; // Chart.js not loaded
  try {
    const [revenue, topItems, peakHours] = await Promise.all([
      api('/api/restaurant/analytics/revenue?days=7').catch(() => []),
      api('/api/restaurant/analytics/top-items?days=7&limit=5').catch(() => []),
      api('/api/restaurant/analytics/peak-hours?days=7').catch(() => ({ hourly: [] })),
    ]);

    const chartOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } };

    // Revenue chart
    const revCtx = document.getElementById('chart-revenue-7d');
    if (revCtx && revenue?.length) {
      if (revCtx._chart) revCtx._chart.destroy();
      revCtx._chart = new Chart(revCtx, {
        type: 'line',
        data: {
          labels: revenue.map(r => r.date?.slice(5) || ''),
          datasets: [{ data: revenue.map(r => Math.round(r.revenue_rs || 0)), borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,.1)', fill: true, tension: .3 }],
        },
        options: { ...chartOpts, scales: { y: { beginAtZero: true, ticks: { callback: v => '₹' + v } } } },
      });
    }

    // Orders chart (reuse revenue data which has order_count)
    const ordCtx = document.getElementById('chart-orders-7d');
    if (ordCtx && revenue?.length) {
      if (ordCtx._chart) ordCtx._chart.destroy();
      ordCtx._chart = new Chart(ordCtx, {
        type: 'bar',
        data: {
          labels: revenue.map(r => r.date?.slice(5) || ''),
          datasets: [{ data: revenue.map(r => r.order_count || 0), backgroundColor: '#22c55e', borderRadius: 4 }],
        },
        options: { ...chartOpts, scales: { y: { beginAtZero: true } } },
      });
    }

    // Top items chart
    const topCtx = document.getElementById('chart-top-items');
    if (topCtx && topItems?.length) {
      if (topCtx._chart) topCtx._chart.destroy();
      topCtx._chart = new Chart(topCtx, {
        type: 'doughnut',
        data: {
          labels: topItems.map(i => i.item_name || ''),
          datasets: [{ data: topItems.map(i => i.total_quantity || 0), backgroundColor: ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4'] }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } } },
      });
    }

    // Peak hours chart
    const peakCtx = document.getElementById('chart-peak-hours');
    const hourly = peakHours?.hourly || peakHours || [];
    if (peakCtx && hourly?.length) {
      if (peakCtx._chart) peakCtx._chart.destroy();
      const hours = Array.from({ length: 24 }, (_, i) => i);
      const hourMap = {};
      (Array.isArray(hourly) ? hourly : []).forEach(h => { hourMap[h._id ?? h.hour] = h.order_count || h.count || 0; });
      peakCtx._chart = new Chart(peakCtx, {
        type: 'bar',
        data: {
          labels: hours.map(h => `${h}:00`),
          datasets: [{ data: hours.map(h => hourMap[h] || 0), backgroundColor: '#f59e0b', borderRadius: 2 }],
        },
        options: { ...chartOpts, scales: { y: { beginAtZero: true }, x: { ticks: { maxRotation: 90, font: { size: 9 } } } } },
      });
    }
  } catch (e) { console.error('[Overview] Charts failed:', e.message); }
}
async function renderWizard() {
  const waConnected = !!(rest.whatsapp_connected || rest.meta_user_id || (rest.waba_accounts && rest.waba_accounts.length > 0));
  const profileDone = !!(rest.brand_name && rest.phone);
  const hasBranch = branches?.length > 0 || (await api('/api/restaurant/branches').catch(() => []))?.length > 0;
  const hasMenu = hasBranch && (await api('/api/restaurant/menu/all').catch(() => ({ total_count: 0 })))?.total_count > 0;
  const hasCatalog = !!(rest.meta_catalog_id || rest.catalog_id);

  const steps = [
    { l: 'Connect with Meta',     d: 'Link your WhatsApp Business account',             done: waConnected,  fn: () => doBannerConnect() },
    { l: 'Complete your profile',  d: 'Business name, logo, bank account',               done: profileDone,  fn: () => goTab('settings', null) },
    { l: 'Add your first branch',  d: 'GPS coordinates enable location-based ordering',  done: hasBranch,    fn: () => goTab('menu', null) },
    { l: 'Add menu items',         d: 'Items sync to WhatsApp Catalog automatically',    done: hasMenu,      fn: () => goTab('menu', null) },
    { l: 'Sync catalog & go live', d: 'Catalog syncs automatically when you add items',  done: hasCatalog && hasMenu,   fn: () => goTab('menu', null) },
  ];

  // Auto-hide if all steps complete
  if (steps.every(s => s.done)) {
    document.getElementById('ob').style.display = 'none';
    return;
  }

  document.getElementById('ob').style.display = 'block';
  document.getElementById('ob-steps').innerHTML = steps.map((s, i) => {
    const n = i + 1;
    const cls = s.done ? 'wz-done' : 'wz-cur';
    return `<div class="wz">
      <div class="wz-n ${cls}">${s.done ? '✓' : n}</div>
      <div style="flex:1"><b>${s.l}</b><p>${s.d}</p></div>
      ${s.fn && !s.done ? `<button class="btn-g btn-sm" style="flex-shrink:0" onclick="(${s.fn.toString()})()">Go →</button>` : ''}
    </div>`;
  }).join('');
}
async function loadRecent() {
  const w = document.getElementById('recent-body');
  try {
    const o = await api('/api/restaurant/orders?limit=5');
    if (!o?.length) return;
    w.innerHTML = `<div class="tbl"><table>
      <thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${o.map(r => `<tr>
        <td><span class="mono">${r.order_number}</span></td>
        <td>${_esc(r.customer_name || r.wa_phone || r.bsuid?.slice(0,12)+'…' || '—')}</td>
        <td>₹${r.total_rs}</td>
        <td>${sbadge(r.status)}</td>
        <td>${oaction(r)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  } catch (_) {}
}


// Expose to window
window.loadOverview = loadOverview;
window.loadOverviewCharts = loadOverviewCharts;
window.renderWizard = renderWizard;
window.loadRecent = loadRecent;
// loadCatalogStatus is exposed by settings.js (where it's defined)

})();
