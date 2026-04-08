// frontend/js/tabs/orders.js
// Dashboard tab: Orders

(function() {

var oFilter = 'ALL';

async function loadOrders(s) {
  oFilter = s;
  const tb = document.getElementById('orders-body');
  tb.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem"><div class="spin"></div></td></tr>`;
  try {
    const q = s === 'ALL' ? '' : `&status=${s}`;
    const o = await api(`/api/restaurant/orders?limit=60${q}`);
    if (!o?.length) { tb.innerHTML = `<tr><td colspan="8"><div class="empty"><div class="ei">📋</div><h3>No orders found</h3></div></td></tr>`; return; }
    tb.innerHTML = o.map(r => `<tr>
      <td><span class="mono">${r.order_number}</span></td>
      <td><div>${_esc(r.customer_name || '—')}</div><div style="font-size:.72rem;color:var(--dim)">${_esc(r.wa_phone || r.bsuid?.slice(0,12)+'…' || '')}</div></td>
      <td>${_esc(r.branch_name || '')}</td>
      <td>₹${r.total_rs}</td>
      <td>${sbadge(r.status)}</td>
      <td style="font-size:.73rem">${fmtEta(r)}</td>
      <td style="font-size:.73rem;color:var(--dim)">${timeAgo(r.created_at)}</td>
      <td>${oaction({...r, customer_id: r.customer_id})}</td>
    </tr>`).join('');
  } catch (e) { toast('Failed to load orders', 'err'); }
}
function doFilterOrders(s, el) {
  document.querySelectorAll('#ochips .chip').forEach(c => c.classList.remove('on'));
  if (el) el.classList.add('on');
  loadOrders(s);
}
function sbadge(s) {
  const m = {
    PENDING_PAYMENT: ['ba', 'Pending Payment'],
    PAYMENT_FAILED : ['br', 'Payment Failed'],
    EXPIRED        : ['bd', 'Expired'],
    PAID           : ['bb', 'Paid'],
    CONFIRMED      : ['bg', 'Confirmed'],
    PREPARING      : ['ba', 'Preparing'],
    PACKED         : ['bb', 'Packed'],
    DISPATCHED     : ['bv', 'Dispatched'],
    DELIVERED      : ['bg', 'Delivered'],
    CANCELLED      : ['br', 'Cancelled'],
    PAID_OUT       : ['bg', 'Paid Out'],
    PENDING        : ['ba', 'Pending'],
  };
  const [c, label] = m[s] || ['bd', s.replace(/_/g, ' ')];
  return `<span class="badge ${c}">${label}</span>`;
}
function fmtEta(o) {
  const active = ['PAID', 'CONFIRMED', 'PREPARING', 'PACKED', 'DISPATCHED'];
  if (o.status === 'DELIVERED') {
    // Show actual time taken
    if (o.created_at && o.delivered_at) {
      const mins = Math.round((new Date(o.delivered_at) - new Date(o.created_at)) / 60000);
      return `<span style="color:var(--wa)">Delivered in ${mins} min</span>`;
    }
    return '<span style="color:var(--wa)">Delivered</span>';
  }
  if (active.includes(o.status) && o.eta_text) {
    return `<span style="color:var(--gold);font-weight:600">⏱ ${o.eta_text}</span>`;
  }
  return '<span style="color:var(--mute)">—</span>';
}
function oaction(o) {
  const nxt = { PAID: ['CONFIRMED', '✅ Confirm'], CONFIRMED: ['PREPARING', '👨‍🍳 Prep'], PREPARING: ['PACKED', '📦 Packed'] };
  const a = nxt[o.status];
  const viewBtn = `<button class="btn-outline btn-sm" style="margin-left:.4rem" onclick="openOrdModal('${o.id}')">Detail</button>`;
  const histBtn = o.customer_id ? `<button class="btn-outline btn-sm" style="margin-left:.3rem;font-size:.7rem" onclick="showCustOrderHistory('${o.customer_id}','${(o.customer_name||'Customer').replace(/'/g,"\\'")}')">History</button>` : '';
  if (!a) return viewBtn + histBtn;
  return `<button class="btn-g btn-sm" onclick="doUpdateOrder('${o.id}','${a[0]}')">${a[1]}</button>${viewBtn}${histBtn}`;
}

function closeOrdModal() {
  document.getElementById('ord-modal').style.display = 'none';
}

async function openOrdModal(orderId) {
  const modal = document.getElementById('ord-modal');
  const body  = document.getElementById('ord-modal-body');
  modal.style.display = 'flex';
  body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--dim)">Loading…</div>';
  try {
    const o = await api(`/api/restaurant/orders/${orderId}`);
    if (!o) { body.innerHTML = '<p>Order not found.</p>'; return; }

    document.getElementById('ord-modal-title').textContent = `Order #${o.order_number}`;

    const itemRows = (o.items || []).map(i =>
      `<tr><td style="padding:.35rem 0">${i.item_name}</td><td style="text-align:center">×${i.quantity}</td><td style="text-align:right">₹${parseFloat(i.line_total_rs).toFixed(2)}</td></tr>`
    ).join('');

    const dl = (label, value, bold) =>
      `<tr><td style="padding:.25rem 0;color:var(--dim)">${label}</td><td style="text-align:right;${bold?'font-weight:700':''}">₹${parseFloat(value||0).toFixed(2)}</td></tr>`;
    const sep = `<tr><td colspan="2"><hr style="border:none;border-top:1px dashed var(--rim2);margin:.3rem 0"></td></tr>`;

    const hasCharges = o.food_gst_rs != null || o.packaging_rs != null;

    let chargeRows = dl('Subtotal', o.subtotal_rs);
    if (hasCharges) {
      if (parseFloat(o.food_gst_rs||0) > 0) chargeRows += dl('Food GST (5%)', o.food_gst_rs);
      if (parseFloat(o.customer_delivery_rs||0) > 0) {
        chargeRows += dl('Delivery', o.customer_delivery_rs);
        chargeRows += dl('Delivery GST (18%)', o.customer_delivery_gst_rs);
      } else if (parseFloat(o.delivery_fee_rs||0) > 0) {
        chargeRows += dl('Delivery', o.delivery_fee_rs);
      }
      if (parseFloat(o.packaging_rs||0) > 0) {
        chargeRows += dl('Packaging', o.packaging_rs);
        if (parseFloat(o.packaging_gst_rs||0) > 0) chargeRows += dl('Packaging GST', o.packaging_gst_rs);
      }
    } else {
      chargeRows += dl('Delivery', o.delivery_fee_rs);
    }
    if (parseFloat(o.discount_rs||0) > 0) {
      chargeRows += `<tr><td style="padding:.25rem 0;color:var(--dim)">Discount ${o.coupon_code?`(${o.coupon_code})`:''}  </td><td style="text-align:right;color:#16a34a">−₹${parseFloat(o.discount_rs).toFixed(2)}</td></tr>`;
    }
    chargeRows += sep;
    chargeRows += dl('Customer Total', o.total_rs, true);

    // Dynamic pricing breakdown
    let dynamicNote = '';
    if (o.delivery_fee_breakdown && o.delivery_fee_breakdown.distanceKm !== null) {
      const bd = o.delivery_fee_breakdown;
      const parts = [`${bd.distanceKm} km`];
      if (bd.baseFee) parts.push(`Base ₹${bd.baseFee}`);
      if (bd.distanceFee) parts.push(`Distance ₹${bd.distanceFee}`);
      if (bd.effectiveMultiplier > 1.0) parts.push(`${bd.effectiveMultiplier}x${bd.reason ? ' (' + bd.reason + ')' : ''}`);
      if (bd.capped) parts.push('Capped');
      dynamicNote = `<div style="margin-top:.4rem;font-size:.72rem;color:var(--dim)">⚡ ${parts.join(' · ')}</div>`;
    }

    let settlementNote = '';
    if (parseFloat(o.restaurant_delivery_rs||0) > 0) {
      const deduction = parseFloat(o.restaurant_delivery_rs||0) + parseFloat(o.restaurant_delivery_gst_rs||0);
      settlementNote = `<div style="margin-top:.8rem;padding:.65rem .9rem;background:#fef9ec;border:1px solid #fde68a;border-radius:8px;font-size:.78rem;color:#92400e">
        Settlement deduction: <strong>₹${deduction.toFixed(2)}</strong> (restaurant delivery share + GST)
      </div>`;
    }

    body.innerHTML = `
      <div style="margin-bottom:.8rem">
        <span style="font-size:.75rem;color:var(--dim)">Customer</span>
        <div style="font-weight:600">${_esc(o.customer_name||'—')} · ${_esc(o.wa_phone || o.bsuid?.slice(0,12)+'…' || '')}</div>
        ${o.delivery_address ? `<div style="font-size:.75rem;color:var(--dim);margin-top:.2rem">\uD83D\uDCCD ${_esc(o.delivery_address)}</div>` : (o.delivery_lat && o.delivery_lng ? `<div style="font-size:.75rem;margin-top:.2rem"><a href="https://www.google.com/maps?q=${o.delivery_lat},${o.delivery_lng}" target="_blank" style="color:var(--acc);text-decoration:none">\uD83D\uDCCD View on Maps</a></div>` : '')}
      </div>
      <div style="margin-bottom:.8rem">
        <span style="font-size:.75rem;color:var(--dim)">Items</span>
        <table style="width:100%;border-collapse:collapse;margin-top:.3rem">${itemRows}</table>
      </div>
      <div>
        <span style="font-size:.75rem;color:var(--dim)">Charge Breakdown</span>
        <table style="width:100%;border-collapse:collapse;margin-top:.3rem">${chargeRows}</table>
      </div>
      ${dynamicNote}
      ${settlementNote}
    `;

    // Load delivery info
    try {
      const dRes = await api('/api/restaurant/orders/' + orderId + '/delivery');
      const d = dRes.delivery;
      if (d) {
        const statusColors = { delivered: '#16a34a', picked_up: '#2563eb', assigned: '#d97706', pending: '#6b7280', failed: '#dc2626', cancelled: '#dc2626' };
        const statusColor = statusColors[d.status] || '#6b7280';
        let deliveryHtml = `
          <div style="margin-top:.8rem;padding:.65rem .9rem;background:var(--ink2);border:1px solid var(--bdr);border-radius:8px">
            <div style="font-size:.75rem;color:var(--dim);margin-bottom:.4rem">🚴 Delivery</div>
            <div style="display:flex;gap:.8rem;align-items:center;flex-wrap:wrap;font-size:.82rem">
              <span style="background:${statusColor}22;color:${statusColor};padding:.15rem .5rem;border-radius:4px;font-weight:600;font-size:.75rem">${(d.status||'pending').toUpperCase()}</span>
              ${d.provider ? `<span style="color:var(--dim)">${d.provider}</span>` : ''}
              ${d.driver_name ? `<span>👤 ${d.driver_name}</span>` : ''}
              ${d.driver_phone ? `<a href="tel:${d.driver_phone}" style="color:var(--wa)">📞 ${d.driver_phone}</a>` : ''}
              ${d.estimated_mins ? `<span>⏱ ~${d.estimated_mins} min</span>` : ''}
              ${d.cost_rs ? `<span style="color:var(--dim)">₹${parseFloat(d.cost_rs).toFixed(0)} 3PL cost</span>` : ''}
            </div>
            <div style="margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap">
              ${d.tracking_url ? `<a href="${d.tracking_url}" target="_blank" class="btn-p btn-sm" style="text-decoration:none;font-size:.75rem">📍 Track Delivery</a>` : ''}
              ${(d.status === 'failed' || d.status === 'cancelled') ? `<button class="btn-g btn-sm" style="font-size:.75rem" onclick="doDispatch('${orderId}')">🔄 Re-dispatch</button>` : ''}
              ${(d.status === 'assigned' || d.status === 'picked_up') ? `<button class="btn-sm" style="font-size:.75rem;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;border-radius:4px;cursor:pointer" onclick="doCancelDelivery('${orderId}')">❌ Cancel Delivery</button>` : ''}
              ${d.status === 'pending' ? `<button class="btn-p btn-sm" style="font-size:.75rem" onclick="doDispatch('${orderId}')">🚴 Dispatch Now</button>` : ''}
            </div>
          </div>`;
        body.innerHTML += deliveryHtml;
      }
    } catch (de) { /* delivery info optional */ }
  } catch (e) { body.innerHTML = `<p style="color:var(--red)">${e.message}</p>`; }
}
async function doUpdateOrder(id, s) {
  try { await api(`/api/restaurant/orders/${id}/status`, { method: 'PATCH', body: { status: s } }); toast('Order updated ✓', 'ok'); loadOrders(oFilter); }
  catch (e) { toast(e.message, 'err'); }
}
async function doDispatch(orderId) {
  try {
    await api(`/api/restaurant/orders/${orderId}/dispatch`, { method: 'POST' });
    toast('Delivery dispatched ✓', 'ok');
    showOrderDetail(orderId);
  } catch (e) { toast(e.message, 'err'); }
}
async function doCancelDelivery(orderId) {
  if (!confirm('Cancel the active delivery?')) return;
  try {
    await api(`/api/restaurant/orders/${orderId}/cancel-delivery`, { method: 'POST' });
    toast('Delivery cancelled', 'ok');
    showOrderDetail(orderId);
  } catch (e) { toast(e.message, 'err'); }
}


// Expose to window
window.loadOrders = loadOrders;
window.doFilterOrders = doFilterOrders;
window.sbadge = sbadge;
window.fmtEta = fmtEta;
window.oaction = oaction;
window.closeOrdModal = closeOrdModal;
window.openOrdModal = openOrdModal;
window.doUpdateOrder = doUpdateOrder;
window.doDispatch = doDispatch;
window.doCancelDelivery = doCancelDelivery;

})();
