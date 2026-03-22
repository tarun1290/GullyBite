// src/services/settlement-export.js
// Generates a 4-sheet Excel workbook for a given settlement

'use strict';

const ExcelJS = require('exceljs');
const { col } = require('../config/database');

// ─── STYLE CONSTANTS ────────────────────────────────────────────
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const CURRENCY_FMT = '₹#,##0.00';
const PCT_FMT = '0.00%';
const DATE_FMT = 'DD-MMM-YYYY';
const DATETIME_FMT = 'DD-MMM-YYYY HH:MM';

// ─── HELPERS ────────────────────────────────────────────────────
const round2 = n => Math.round((n || 0) * 100) / 100;

function styleHeaders(sheet) {
  const row = sheet.getRow(1);
  row.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  row.height = 28;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function autoWidth(sheet) {
  sheet.columns.forEach(col => {
    let max = col.header ? col.header.length : 10;
    col.eachCell({ includeEmpty: false }, cell => {
      const len = cell.value != null ? String(cell.value).length : 0;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 4, 40);
  });
}

// ─── MAIN EXPORT ────────────────────────────────────────────────
async function generateSettlementExcel(settlementId) {
  const settlement = await col('settlements').findOne({ _id: settlementId });
  if (!settlement) throw new Error('Settlement not found');

  const restaurant = await col('restaurants').findOne(
    { _id: { $in: [settlement.restaurant_id, require('mongodb').ObjectId.createFromHexString?.(settlement.restaurant_id)] } },
    { projection: { business_name: 1, brand_name: 1, commission_pct: 1, city: 1, phone: 1 } }
  );

  // Fetch orders for this settlement
  const orders = await col('orders').find({ settlement_id: settlementId }).sort({ created_at: 1 }).toArray();
  const orderIds = orders.map(o => String(o._id));

  // Fetch order items
  const items = await col('order_items').find({ order_id: { $in: orderIds } }).toArray();
  const itemsByOrder = {};
  for (const item of items) {
    (itemsByOrder[item.order_id] ||= []).push(item);
  }

  // Fetch refund payments
  const refundPayments = await col('payments').find({
    order_id: { $in: orderIds },
    status: 'refunded',
  }).toArray();

  // ── BUILD WORKBOOK ──────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GullyBite';
  wb.created = new Date();

  // ── SHEET 1: SUMMARY ──────────────────────────────────────
  const ws1 = wb.addWorksheet('Summary');
  const restaurantName = restaurant?.brand_name || restaurant?.business_name || 'Restaurant';
  const commissionPct = parseFloat(restaurant?.commission_pct || 10);

  ws1.columns = [
    { header: 'Field', key: 'field', width: 30 },
    { header: 'Value', key: 'value', width: 25 },
  ];

  const summaryRows = [
    { field: 'Restaurant', value: restaurantName },
    { field: 'City', value: restaurant?.city || '—' },
    { field: 'Settlement ID', value: String(settlementId) },
    { field: 'Period Start', value: settlement.period_start },
    { field: 'Period End', value: settlement.period_end },
    { field: 'Total Orders', value: settlement.orders_count },
    { field: 'Gross Revenue', value: round2(settlement.gross_revenue_rs) },
    { field: 'Platform Fee (' + commissionPct + '%)', value: round2(settlement.platform_fee_rs) },
    { field: 'Delivery Costs (Restaurant Share)', value: round2(settlement.delivery_costs_rs) },
    { field: 'Refunds', value: round2(settlement.refunds_rs) },
    { field: 'Net Payout', value: round2(settlement.net_payout_rs) },
    { field: 'Payout Status', value: settlement.payout_status },
    { field: 'Razorpay Payout ID', value: settlement.rp_payout_id || '—' },
    { field: 'Payout Date', value: settlement.payout_at || '—' },
  ];

  summaryRows.forEach(r => ws1.addRow(r));

  // Format currency rows
  [7, 8, 9, 10, 11].forEach(rowNum => {
    ws1.getCell(`B${rowNum}`).numFmt = CURRENCY_FMT;
  });
  // Format date rows
  [4, 5].forEach(rowNum => {
    ws1.getCell(`B${rowNum}`).numFmt = DATE_FMT;
  });

  styleHeaders(ws1);
  autoWidth(ws1);

  // ── SHEET 2: ORDER DETAILS ────────────────────────────────
  const ws2 = wb.addWorksheet('Order Details');
  ws2.columns = [
    { header: 'Order ID', key: 'order_id', width: 26 },
    { header: 'Date', key: 'date', width: 18 },
    { header: 'Customer', key: 'customer', width: 20 },
    { header: 'Phone', key: 'phone', width: 15 },
    { header: 'Subtotal', key: 'subtotal', width: 12 },
    { header: 'Food GST', key: 'food_gst', width: 12 },
    { header: 'Delivery (Customer)', key: 'cust_delivery', width: 18 },
    { header: 'Delivery GST', key: 'delivery_gst', width: 14 },
    { header: 'Packaging', key: 'packaging', width: 12 },
    { header: 'Discount', key: 'discount', width: 12 },
    { header: 'Total', key: 'total', width: 12 },
    { header: 'Platform Fee', key: 'platform_fee', width: 14 },
    { header: 'Restaurant Delivery Deduction', key: 'rest_delivery', width: 28 },
    { header: 'Status', key: 'status', width: 12 },
  ];

  for (const order of orders) {
    ws2.addRow({
      order_id: String(order._id),
      date: order.created_at || order.delivered_at,
      customer: order.customer_name || '—',
      phone: order.customer_phone || '—',
      subtotal: round2(order.subtotal_rs),
      food_gst: round2(order.food_gst_rs),
      cust_delivery: round2(order.customer_delivery_rs),
      delivery_gst: round2(order.customer_delivery_gst_rs),
      packaging: round2(order.packaging_rs),
      discount: round2(order.discount_rs),
      total: round2(order.total_rs),
      platform_fee: round2((order.subtotal_rs || 0) * commissionPct / 100),
      rest_delivery: round2((order.restaurant_delivery_rs || 0) + (order.restaurant_delivery_gst_rs || 0)),
      status: order.status,
    });
  }

  // Format currency columns (E through M = columns 5-13)
  ws2.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    for (let c = 5; c <= 13; c++) {
      row.getCell(c).numFmt = CURRENCY_FMT;
    }
    row.getCell(2).numFmt = DATETIME_FMT;
  });

  styleHeaders(ws2);
  autoWidth(ws2);

  // ── SHEET 3: ORDER ITEMS ──────────────────────────────────
  const ws3 = wb.addWorksheet('Order Items');
  ws3.columns = [
    { header: 'Order ID', key: 'order_id', width: 26 },
    { header: 'Item Name', key: 'name', width: 30 },
    { header: 'Variant', key: 'variant', width: 18 },
    { header: 'Qty', key: 'qty', width: 6 },
    { header: 'Unit Price', key: 'unit_price', width: 12 },
    { header: 'Line Total', key: 'line_total', width: 12 },
    { header: 'Type', key: 'type', width: 10 },
  ];

  for (const order of orders) {
    const oItems = itemsByOrder[String(order._id)] || [];
    for (const item of oItems) {
      ws3.addRow({
        order_id: String(order._id),
        name: item.name || item.item_name || '—',
        variant: item.variant_value || '—',
        qty: item.quantity || item.qty || 1,
        unit_price: round2(item.price_rs || (item.price_paise ? item.price_paise / 100 : 0)),
        line_total: round2((item.price_rs || (item.price_paise ? item.price_paise / 100 : 0)) * (item.quantity || item.qty || 1)),
        type: item.veg_type || item.type || '—',
      });
    }
  }

  ws3.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    row.getCell(5).numFmt = CURRENCY_FMT;
    row.getCell(6).numFmt = CURRENCY_FMT;
  });

  styleHeaders(ws3);
  autoWidth(ws3);

  // ── SHEET 4: REFUNDS ──────────────────────────────────────
  const ws4 = wb.addWorksheet('Refunds');
  ws4.columns = [
    { header: 'Payment ID', key: 'payment_id', width: 26 },
    { header: 'Order ID', key: 'order_id', width: 26 },
    { header: 'Date', key: 'date', width: 18 },
    { header: 'Amount', key: 'amount', width: 12 },
    { header: 'Razorpay ID', key: 'rp_id', width: 28 },
    { header: 'Reason', key: 'reason', width: 30 },
  ];

  for (const p of refundPayments) {
    ws4.addRow({
      payment_id: String(p._id),
      order_id: p.order_id || '—',
      date: p.updated_at || p.created_at,
      amount: round2(p.amount_rs),
      rp_id: p.rp_payment_id || p.razorpay_payment_id || '—',
      reason: p.refund_reason || '—',
    });
  }

  ws4.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    row.getCell(3).numFmt = DATETIME_FMT;
    row.getCell(4).numFmt = CURRENCY_FMT;
  });

  styleHeaders(ws4);
  autoWidth(ws4);

  // If no refunds, add a note
  if (!refundPayments.length) {
    ws4.addRow({ payment_id: 'No refunds in this period' });
    ws4.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };
  }

  // ── RETURN BUFFER ─────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  return {
    buffer,
    filename: `Settlement_${restaurantName.replace(/[^a-zA-Z0-9]/g, '_')}_${settlement.period_start.toISOString().split('T')[0]}.xlsx`,
  };
}

module.exports = { generateSettlementExcel };
