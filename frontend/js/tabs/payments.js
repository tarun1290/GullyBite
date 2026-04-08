// frontend/js/tabs/payments.js
// Dashboard tab: Payments (Financials + Settlements + Wallet)

(function() {

var finPeriod = '1d', finChartInstance = null, finSettlePage = 1, finPayPage = 1, finCurrentSettleId = null;

async function loadFinancials() {
  await Promise.all([loadFinSummary(), loadFinChart(), loadFinSettlements(1), loadFinPayments(1), loadFinTax()]);
}

function setFinPeriod(p, btn) {
  finPeriod = p;
  document.querySelectorAll('.fin-period-btn').forEach(function(b) { b.classList.remove('on'); });
  if (btn) btn.classList.add('on');
  document.getElementById('fin-custom-range').style.display = 'none';
  loadFinSummary();
  loadFinChart();
}

function toggleFinCustomRange() {
  var el = document.getElementById('fin-custom-range');
  el.style.display = el.style.display === 'none' ? 'flex' : 'none';
}

function applyFinCustomRange() {
  var from = document.getElementById('fin-date-from').value;
  var to = document.getElementById('fin-date-to').value;
  if (!from || !to) { toast('Select both dates', 'err'); return; }
  finPeriod = 'custom&from=' + from + '&to=' + to;
  document.querySelectorAll('.fin-period-btn').forEach(function(b) { b.classList.remove('on'); });
  document.getElementById('fin-custom-btn').classList.add('on');
  loadFinSummary();
  loadFinChart();
}

async function loadFinSummary() {
  try {
    var d = await api('/api/restaurant/financials/summary?period=' + finPeriod);
    if (!d) return;
    document.getElementById('fin-revenue').textContent = fmtINR(d.total_revenue);
    document.getElementById('fin-net').textContent = fmtINR(d.net_earnings);
    document.getElementById('fin-orders').textContent = d.orders_count || '0';
    document.getElementById('fin-aov').textContent = fmtINR(d.avg_order_value);
    if (d.revenue_change != null) {
      var el = document.getElementById('fin-revenue-sub');
      el.textContent = (d.revenue_change >= 0 ? '+' : '') + d.revenue_change.toFixed(1) + '% vs prev period';
      el.className = 'stat-s' + (d.revenue_change < 0 ? ' dn' : '');
    }
    if (d.orders_change != null) {
      var el2 = document.getElementById('fin-orders-sub');
      el2.textContent = (d.orders_change >= 0 ? '+' : '') + d.orders_change.toFixed(1) + '% vs prev period';
      el2.className = 'stat-s' + (d.orders_change < 0 ? ' dn' : '');
    }
    renderFinBreakdown(d.breakdown || d);
  } catch (e) { console.warn('loadFinSummary:', e); }
}

function renderFinBreakdown(b) {
  var el = document.getElementById('fin-breakdown');
  var line = function(label, val, sign, tip) {
    var sn = sign === '+' ? '+' : sign === '-' ? '-' : ' ';
    var color = sign === '-' ? 'var(--red)' : sign === '+' ? 'var(--wa)' : 'var(--tx)';
    var tipHtml = tip ? ' <span title="' + tip + '" style="cursor:help;color:var(--mute);font-size:.72rem">&#9432;</span>' : '';
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:.15rem 0">' +
      '<span style="color:var(--dim)">' + label + tipHtml + '</span>' +
      '<span style="color:' + color + ';font-weight:500">' + sn + ' ' + fmtINR(Math.abs(val || 0)) + '</span>' +
    '</div>';
  };
  var divider = '<div style="border-top:1px solid var(--rim);margin:.5rem 0"></div>';
  var boldLine = function(label, val, color) {
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:.25rem 0">' +
      '<span style="font-weight:700;color:' + (color || 'var(--tx)') + '">' + label + '</span>' +
      '<span style="font-weight:700;color:' + (color || 'var(--tx)') + ';font-size:.95rem">' + fmtINR(val || 0) + '</span>' +
    '</div>';
  };

  el.innerHTML =
    '<div style="font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin-bottom:.4rem;font-family:var(--font-body)">EARNINGS SUMMARY</div>' +
    divider +
    line('Food Revenue', b.food_revenue, '', 'Revenue from food items sold') +
    line('Food GST (5%)', b.food_gst, '+', 'GST collected on food orders') +
    line('Packaging', b.packaging_revenue, '+', 'Packaging charges collected') +
    line('Packaging GST', b.packaging_gst, '+', 'GST on packaging') +
    line('Delivery Fee (Customer)', b.delivery_fee_customer, '+', 'Delivery charges paid by customers') +
    divider +
    boldLine('GROSS COLLECTIONS', b.gross_collections, 'var(--acc)') +
    divider +
    '<div style="font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:.5rem 0 .3rem;font-family:var(--font-body)">DEDUCTIONS</div>' +
    line('Platform Fee', b.platform_fee, '-', 'GullyBite platform commission') +
    line('Platform Fee GST (18%)', b.platform_fee_gst, '-', 'GST charged on platform fee') +
    line('Delivery Cost (Restaurant)', b.delivery_cost, '-', 'Delivery partner charges borne by restaurant') +
    line('Delivery GST', b.delivery_gst, '-', 'GST on delivery cost') +
    line('Discounts', b.discounts, '-', 'Discount amounts funded by restaurant') +
    line('Refunds', b.refunds, '-', 'Refund amounts for cancelled/returned orders') +
    line('TDS (1%)', b.tds, '-', 'Tax Deducted at Source u/s 194-O') +
    line('Referral Fee', b.referral_fee, '-', 'Referral commission for referred customers') +
    line('Referral Fee GST', b.referral_fee_gst, '-', 'GST on referral fees') +
    divider +
    boldLine('TOTAL DEDUCTIONS', b.total_deductions, 'var(--red)') +
    divider +
    boldLine('NET PAYOUT', b.net_payout, 'var(--wa)');
}

async function loadFinChart() {
  try {
    var d = await api('/api/restaurant/financials/daily?period=' + finPeriod);
    var canvas = document.getElementById('fin-chart');
    var emptyEl = document.getElementById('fin-chart-empty');
    if (!d || !d.days || !d.days.length) {
      canvas.style.display = 'none';
      emptyEl.style.display = 'block';
      if (finChartInstance) { finChartInstance.destroy(); finChartInstance = null; }
      return;
    }
    canvas.style.display = 'block';
    emptyEl.style.display = 'none';

    var labels = d.days.map(function(r) { return r.date; });
    var revenue = d.days.map(function(r) { return parseFloat(r.revenue || 0); });
    var net = d.days.map(function(r) { return parseFloat(r.net_earnings || 0); });
    var orders = d.days.map(function(r) { return parseInt(r.orders || 0); });

    if (finChartInstance) finChartInstance.destroy();

    finChartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'line', label: 'Revenue', data: revenue, borderColor: '#2563eb',
            backgroundColor: 'rgba(37,99,235,.08)', borderWidth: 2, pointRadius: 3,
            pointBackgroundColor: '#2563eb', tension: 0.3, fill: true, yAxisID: 'y', order: 1
          },
          {
            type: 'line', label: 'Net Earnings', data: net, borderColor: '#16a34a',
            backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3,
            pointBackgroundColor: '#16a34a', tension: 0.3, fill: false, yAxisID: 'y', order: 2
          },
          {
            type: 'bar', label: 'Orders', data: orders, backgroundColor: 'rgba(148,163,184,.25)',
            borderColor: 'rgba(148,163,184,.4)', borderWidth: 1, borderRadius: 4,
            yAxisID: 'y1', order: 3, barPercentage: 0.5
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, padding: 16, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                if (ctx.dataset.yAxisID === 'y1') return ctx.dataset.label + ': ' + ctx.raw;
                return ctx.dataset.label + ': ' + fmtINR(ctx.raw);
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: {
            position: 'left', grid: { color: 'rgba(0,0,0,.04)' },
            ticks: { font: { size: 10 }, callback: function(v) { return '\u20B9' + (v >= 1000 ? (v/1000).toFixed(0) + 'k' : v); } }
          },
          y1: {
            position: 'right', grid: { drawOnChartArea: false },
            ticks: { font: { size: 10 }, stepSize: 1 }
          }
        }
      }
    });
  } catch (e) { console.warn('loadFinChart:', e); }
}

async function loadFinSettlements(page) {
  if (page < 1) return;
  finSettlePage = page || 1;
  var tb = document.getElementById('fin-settle-body');
  try {
    var d = await api('/api/restaurant/financials/settlements?page=' + finSettlePage + '&limit=10');
    if (!d || !d.settlements || !d.settlements.length) {
      if (finSettlePage > 1) { finSettlePage--; return; }
      tb.innerHTML = '<tr><td colspan="8"><div class="empty"><div class="ei">\uD83D\uDCB0</div><h3>No settlements yet</h3><p>Settlements appear after your first payout cycle</p></div></td></tr>';
      document.getElementById('fin-settle-pag').style.display = 'none';
      return;
    }
    tb.innerHTML = d.settlements.map(function(s) {
      var statusCls = { PAID: 'bg', PENDING: 'ba', PROCESSING: 'bb', FAILED: 'br' }[s.payout_status?.toUpperCase()] || 'bd';
      return '<tr>' +
        '<td style="font-size:.8rem">' + (s.period_start || '') + ' \u2192 ' + (s.period_end || '') + '</td>' +
        '<td>' + fmtINR(s.gross_revenue) + '</td>' +
        '<td style="color:var(--red)">' + fmtINR(s.total_deductions) + '</td>' +
        '<td>' + fmtINR(s.tds) + '</td>' +
        '<td><strong>' + fmtINR(s.net_payout) + '</strong></td>' +
        '<td><span class="badge ' + statusCls + '">' + (s.payout_status || 'N/A') + '</span></td>' +
        '<td style="font-size:.72rem;color:var(--dim);font-family:monospace">' + (s.utr || '\u2014') + '</td>' +
        '<td><button class="btn-g btn-sm" onclick="openSettlementDetail(\'' + s.id + '\')">View</button></td>' +
      '</tr>';
    }).join('');
    var pag = document.getElementById('fin-settle-pag');
    pag.style.display = 'flex';
    document.getElementById('fin-settle-info').textContent = 'Page ' + finSettlePage + (d.total_pages ? ' of ' + d.total_pages : '');
    document.getElementById('fin-settle-prev').disabled = finSettlePage <= 1;
    document.getElementById('fin-settle-next').disabled = !d.has_more && (!d.total_pages || finSettlePage >= d.total_pages);
  } catch (e) { console.warn('loadFinSettlements:', e); }
}

async function openSettlementDetail(id) {
  finCurrentSettleId = id;
  var modal = document.getElementById('fin-settle-modal');
  var body = document.getElementById('fin-settle-modal-body');
  modal.style.display = 'flex';
  body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--dim)">Loading...</div>';
  try {
    var d = await api('/api/restaurant/financials/settlements/' + id);
    if (!d) { body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--red)">Failed to load</div>'; return; }
    var statusCls = { PAID: 'bg', PENDING: 'ba', PROCESSING: 'bb', FAILED: 'br' }[d.payout_status?.toUpperCase()] || 'bd';

    var html = '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;flex-wrap:wrap;gap:.6rem">' +
        '<div>' +
          '<div style="font-size:.72rem;color:var(--dim);margin-bottom:.2rem">Period</div>' +
          '<div style="font-weight:700">' + (d.period_start || '') + ' \u2192 ' + (d.period_end || '') + '</div>' +
        '</div>' +
        '<div style="text-align:right">' +
          '<span class="badge ' + statusCls + '" style="font-size:.75rem">' + (d.payout_status || 'N/A') + '</span>' +
          (d.utr ? '<div style="font-size:.72rem;color:var(--dim);margin-top:.2rem">UTR: <span style="font-family:monospace">' + d.utr + '</span></div>' : '') +
          (d.payout_date ? '<div style="font-size:.72rem;color:var(--dim)">Paid: ' + d.payout_date + '</div>' : '') +
        '</div>' +
      '</div>';

    // Breakdown
    html += '<div id="fin-settle-breakdown" style="font-family:\'SF Mono\',monospace;font-size:.78rem;line-height:1.9;background:var(--ink4);border-radius:8px;padding:1rem 1.2rem;margin-bottom:1rem"></div>';

    // Order list
    if (d.orders && d.orders.length) {
      html += '<div style="font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin-bottom:.4rem">Orders in this Settlement (' + d.orders.length + ')</div>';
      html += '<div style="max-height:200px;overflow-y:auto;border:1px solid var(--rim);border-radius:8px"><table><thead><tr><th>Order #</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>';
      d.orders.forEach(function(o) {
        html += '<tr><td style="font-family:monospace;font-size:.75rem">' + (o.order_number || o.id) + '</td><td style="font-size:.78rem">' + (o.date || '') + '</td><td>' + fmtINR(o.amount) + '</td><td><span class="badge bg">' + (o.status || 'Delivered') + '</span></td></tr>';
      });
      html += '</tbody></table></div>';
    }

    body.innerHTML = html;

    // Render breakdown inside the modal
    var bk = d.breakdown || d;
    var bdEl = document.getElementById('fin-settle-breakdown');
    if (bdEl) {
      var ln = function(l, v, s) { return '<div style="display:flex;justify-content:space-between"><span style="color:var(--dim)">' + l + '</span><span style="color:' + (s==='-'?'var(--red)':s==='+'?'var(--wa)':'var(--tx)') + '">' + (s||'') + ' ' + fmtINR(Math.abs(v||0)) + '</span></div>'; };
      var dv = '<div style="border-top:1px dashed var(--rim);margin:.3rem 0"></div>';
      var bl = function(l, v, c) { return '<div style="display:flex;justify-content:space-between;font-weight:700"><span style="color:' + (c||'var(--tx)') + '">' + l + '</span><span style="color:' + (c||'var(--tx)') + '">' + fmtINR(v||0) + '</span></div>'; };
      bdEl.innerHTML = ln('Food Revenue',bk.food_revenue,'') + ln('Food GST',bk.food_gst,'+') + ln('Packaging',bk.packaging_revenue,'+') + ln('Packaging GST',bk.packaging_gst,'+') + ln('Delivery Fee',bk.delivery_fee_customer,'+') + dv + bl('GROSS',bk.gross_collections,'var(--acc)') + dv + ln('Platform Fee',bk.platform_fee,'-') + ln('Platform Fee GST',bk.platform_fee_gst,'-') + ln('Delivery Cost',bk.delivery_cost,'-') + ln('Delivery GST',bk.delivery_gst,'-') + ln('Discounts',bk.discounts,'-') + ln('Refunds',bk.refunds,'-') + ln('TDS',bk.tds,'-') + ln('Referral Fee',bk.referral_fee,'-') + ln('Referral GST',bk.referral_fee_gst,'-') + dv + bl('NET PAYOUT',bk.net_payout,'var(--wa)');
    }

    document.getElementById('fin-settle-dl-btn').style.display = 'inline-flex';
  } catch (e) {
    body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--red)">Error: ' + _esc(e.message) + '</div>';
  }
}

function closeFinSettleModal() {
  document.getElementById('fin-settle-modal').style.display = 'none';
  finCurrentSettleId = null;
}

function downloadFinSettlement() {
  if (!finCurrentSettleId) return;
  var a = document.createElement('a');
  a.href = '/api/restaurant/settlements/' + finCurrentSettleId + '/download';
  a.download = 'settlement_' + finCurrentSettleId + '.xlsx';
  a.click();
}

async function loadFinPayments(page) {
  if (page < 1) return;
  finPayPage = page || 1;
  var tb = document.getElementById('fin-pay-body');
  var from = document.getElementById('fin-pay-from').value;
  var to = document.getElementById('fin-pay-to').value;
  var qs = 'page=' + finPayPage + '&limit=15';
  if (from) qs += '&from=' + from;
  if (to) qs += '&to=' + to;
  try {
    var d = await api('/api/restaurant/financials/payments?' + qs);
    if (!d || !d.payments || !d.payments.length) {
      if (finPayPage > 1) { finPayPage--; return; }
      tb.innerHTML = '<tr><td colspan="6"><div class="empty"><div class="ei">\uD83D\uDCB3</div><h3>No payments found</h3><p>Payments will appear as orders come in</p></div></td></tr>';
      document.getElementById('fin-pay-pag').style.display = 'none';
      return;
    }
    tb.innerHTML = d.payments.map(function(p) {
      var statusCls = { CAPTURED: 'bg', SUCCESS: 'bg', PENDING: 'ba', FAILED: 'br', REFUNDED: 'bv' }[p.status?.toUpperCase()] || 'bd';
      return '<tr>' +
        '<td style="font-size:.78rem">' + (p.date || '') + '</td>' +
        '<td style="font-family:monospace;font-size:.75rem">' + (p.order_number || '\u2014') + '</td>' +
        '<td>' + fmtINR(p.amount) + '</td>' +
        '<td style="font-size:.78rem">' + (p.method || '\u2014') + '</td>' +
        '<td style="font-family:monospace;font-size:.72rem;color:var(--dim)">' + (p.razorpay_id || '\u2014') + '</td>' +
        '<td><span class="badge ' + statusCls + '">' + (p.status || 'N/A') + '</span></td>' +
      '</tr>';
    }).join('');
    var pag = document.getElementById('fin-pay-pag');
    pag.style.display = 'flex';
    document.getElementById('fin-pay-info').textContent = 'Page ' + finPayPage + (d.total_pages ? ' of ' + d.total_pages : '');
    document.getElementById('fin-pay-prev').disabled = finPayPage <= 1;
    document.getElementById('fin-pay-next').disabled = !d.has_more && (!d.total_pages || finPayPage >= d.total_pages);
  } catch (e) { console.warn('loadFinPayments:', e); }
}

async function loadFinTax() {
  try {
    var d = await api('/api/restaurant/financials/tax-summary');
    if (!d) return;

    // GST monthly table
    var gstBody = document.getElementById('fin-gst-body');
    if (d.gst_monthly && d.gst_monthly.length) {
      gstBody.innerHTML = d.gst_monthly.map(function(m) { return '<tr>' +
        '<td style="font-weight:600;font-size:.8rem">' + m.month + '</td>' +
        '<td>' + fmtINR(m.food_gst) + '</td>' +
        '<td>' + fmtINR(m.packaging_gst) + '</td>' +
        '<td>' + fmtINR(m.delivery_gst) + '</td>' +
        '<td>' + fmtINR(m.platform_fee_gst) + '</td>' +
        '<td><strong>' + fmtINR(m.total_gst) + '</strong></td>' +
      '</tr>'; }).join('');
    } else {
      gstBody.innerHTML = '<tr><td colspan="6"><div class="empty" style="padding:1.5rem"><h3>No GST data yet</h3><p>GST breakdown appears after your first orders</p></div></td></tr>';
    }

    // TDS table
    var tdsBody = document.getElementById('fin-tds-body');
    if (d.tds_records && d.tds_records.length) {
      tdsBody.innerHTML = d.tds_records.map(function(t) { return '<tr>' +
        '<td style="font-family:monospace;font-size:.75rem">' + (t.settlement_id || '\u2014') + '</td>' +
        '<td style="font-size:.8rem">' + (t.period || '') + '</td>' +
        '<td>' + fmtINR(t.gross) + '</td>' +
        '<td>' + (t.tds_rate || '1%') + '</td>' +
        '<td><strong>' + fmtINR(t.tds_amount) + '</strong></td>' +
        '<td>' + (t.certificate_url ? '<a href="' + t.certificate_url + '" target="_blank" class="btn-g btn-sm" style="text-decoration:none">\uD83D\uDCC4 Download</a>' : '<span style="color:var(--mute);font-size:.75rem">Pending</span>') + '</td>' +
      '</tr>'; }).join('');
    } else {
      tdsBody.innerHTML = '<tr><td colspan="6"><div class="empty" style="padding:1.5rem"><h3>No TDS records yet</h3><p>TDS is deducted from settlements</p></div></td></tr>';
    }

    // Tax info
    if (d.gstin) document.getElementById('fin-tax-gstin').textContent = d.gstin;
    if (d.gstin_status) document.getElementById('fin-tax-gst-status').textContent = 'Status: ' + d.gstin_status;
    if (d.pan) document.getElementById('fin-tax-pan').textContent = d.pan;
    if (d.pan_status) document.getElementById('fin-tax-pan-status').textContent = 'Status: ' + d.pan_status;
  } catch (e) { console.warn('loadFinTax:', e); }
}

function switchFinTaxTab(tab, btn) {
  document.querySelectorAll('.fin-tax-panel').forEach(function(p) { p.style.display = 'none'; });
  document.querySelectorAll('.fin-tax-tab').forEach(function(b) { b.classList.remove('on'); });
  document.getElementById('fin-tax-' + tab).style.display = 'block';
  if (btn) btn.classList.add('on');
}

async function loadWallet() {
  try {
    var w = await api('/api/restaurant/wallet');
    if (!w) return;
    var bal = parseFloat(w.balance_rs) || 0;
    document.getElementById('wlt-balance').textContent = '\u20B9' + bal.toFixed(2);
    document.getElementById('wlt-balance').style.color = bal > (w.low_balance_threshold_rs || 100) ? 'var(--wa)' : bal > 0 ? '#d97706' : 'var(--red)';
    document.getElementById('wlt-monthly').textContent = '\u20B9' + (parseFloat(w.monthly_spend_rs) || 0).toFixed(2);
    document.getElementById('wlt-status').textContent = w.status === 'active' ? 'Active' : 'Suspended';
    document.getElementById('wlt-status').style.color = w.status === 'active' ? 'var(--wa)' : 'var(--red)';

    var txns = await api('/api/restaurant/wallet/transactions?limit=20');
    var tbody = document.getElementById('wlt-tbody');
    if (!txns?.length) { tbody.innerHTML = '<tr><td colspan="5" style="padding:1rem;text-align:center;color:var(--dim)">No transactions yet</td></tr>'; return; }
    var typeIco = { topup: '\u2705', deduction: '\uD83D\uDCE4', settlement_deduction: '\uD83D\uDCCB', refund: '\u21A9\uFE0F' };
    tbody.innerHTML = txns.map(function(t) { return '<tr style="border-bottom:1px solid var(--rim)">' +
      '<td style="padding:.45rem .7rem;font-size:.78rem">' + new Date(t.created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) + '</td>' +
      '<td style="padding:.45rem .7rem;font-size:.8rem">' + (typeIco[t.type] || '') + ' ' + t.type + '</td>' +
      '<td style="padding:.45rem .7rem;font-size:.78rem;color:var(--dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _esc(t.description || '\u2014') + '</td>' +
      '<td style="padding:.45rem .7rem;font-weight:600;color:' + (t.amount_rs >= 0 ? 'var(--wa)' : 'var(--red)') + '">' + (t.amount_rs >= 0 ? '+' : '') + '\u20B9' + Math.abs(t.amount_rs).toFixed(2) + '</td>' +
      '<td style="padding:.45rem .7rem;font-size:.78rem">\u20B9' + parseFloat(t.balance_after_rs).toFixed(2) + '</td>' +
    '</tr>'; }).join('');
  } catch (e) { console.error('[Wallet]', e.message); }
}

function showWalletTopup() {
  document.getElementById('wlt-topup-form').style.display = '';
}

async function doWalletTopup(amt) {
  if (!amt || amt < 100 || amt > 10000) return toast('Amount must be \u20B9100 \u2013 \u20B910,000', 'err');
  try {
    var r = await api('/api/restaurant/wallet/topup', { method: 'POST', body: { amount_rs: amt } });
    if (!r?.razorpay_order_id) return toast('Failed to create payment', 'err');
    var rzp = new Razorpay({
      key: r.key_id,
      amount: amt * 100,
      currency: 'INR',
      order_id: r.razorpay_order_id,
      name: 'GullyBite',
      description: 'Messaging Wallet Top-Up',
      handler: function() { toast('Payment received! Wallet will be credited shortly.', 'ok'); document.getElementById('wlt-topup-form').style.display = 'none'; setTimeout(loadWallet, 3000); },
      theme: { color: '#25D366' },
    });
    rzp.open();
  } catch (e) { toast(e.message, 'err'); }
}

async function loadSettlements() {
  var tb = document.getElementById('settle-body');
  try {
    var d = await api('/api/restaurant/settlements');
    if (!d?.length) return;
    tb.innerHTML = d.map(function(s) { return '<tr>' +
      '<td style="font-size:.8rem">' + s.period_start + ' \u2192 ' + s.period_end + '</td>' +
      '<td>' + s.orders_count + '</td>' +
      '<td>\u20B9' + parseFloat(s.gross_revenue_rs).toFixed(0) + '</td>' +
      '<td>\u20B9' + parseFloat(s.platform_fee_rs).toFixed(0) + '</td>' +
      '<td><strong>\u20B9' + parseFloat(s.net_payout_rs).toFixed(0) + '</strong></td>' +
      '<td>' + window.sbadge(s.payout_status.toUpperCase()) + '</td>' +
      '<td><button class="btn-xs" onclick="downloadSettlement(\'' + s.id + '\')" title="Download Excel">\uD83D\uDCE5</button></td>' +
    '</tr>'; }).join('');
  } catch (_) {}
}

async function downloadSettlement(id) {
  try {
    var resp = await fetch('/api/restaurant/settlements/' + id + '/download', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
    if (!resp.ok) throw new Error('Download failed');
    var blob = await resp.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url;
    a.download = resp.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] || 'settlement_' + id + '.xlsx';
    a.click(); URL.revokeObjectURL(url);
  } catch (e) { alert('Download failed: ' + e.message); }
}

// Expose all functions to window for inline onclick handlers
window.loadFinancials = loadFinancials;
window.setFinPeriod = setFinPeriod;
window.toggleFinCustomRange = toggleFinCustomRange;
window.applyFinCustomRange = applyFinCustomRange;
window.loadFinSummary = loadFinSummary;
window.renderFinBreakdown = renderFinBreakdown;
window.loadFinChart = loadFinChart;
window.loadFinSettlements = loadFinSettlements;
window.openSettlementDetail = openSettlementDetail;
window.closeFinSettleModal = closeFinSettleModal;
window.downloadFinSettlement = downloadFinSettlement;
window.loadFinPayments = loadFinPayments;
window.loadFinTax = loadFinTax;
window.switchFinTaxTab = switchFinTaxTab;
window.loadWallet = loadWallet;
window.showWalletTopup = showWalletTopup;
window.doWalletTopup = doWalletTopup;
window.loadSettlements = loadSettlements;
window.downloadSettlement = downloadSettlement;

})();
