// src/services/settlement-export.js
// Generates a multi-sheet Excel workbook for a given settlement
// Sheets: Summary, Order Details, Order Items, Refunds, Tax Summary, Messaging Costs

'use strict';

const ExcelJS = require('exceljs');
const { col } = require('../config/database');
const { getTaxSummary, round2, GST_PLATFORM_FEE_PCT } = require('./financials');

// ─── STYLE CONSTANTS ────────────────────────────────────────────
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const SECTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
const SECTION_FONT = { bold: true, size: 11 };
const TOTAL_FONT   = { bold: true, size: 12 };
const CURRENCY_FMT = '₹#,##0.00';
const DATE_FMT = 'DD-MMM-YYYY';
const DATETIME_FMT = 'DD-MMM-YYYY HH:MM';

// ─── HELPERS ────────────────────────────────────────────────────
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
  sheet.columns.forEach(c => {
    let max = c.header ? c.header.length : 10;
    c.eachCell({ includeEmpty: false }, cell => {
      const len = cell.value != null ? String(cell.value).length : 0;
      if (len > max) max = len;
    });
    c.width = Math.min(max + 4, 45);
  });
}

function addSummaryLine(ws, field, value, isCurrency = false, style = {}) {
  const row = ws.addRow({ field, value });
  if (isCurrency) row.getCell(2).numFmt = CURRENCY_FMT;
  if (style.bold) row.font = { bold: true };
  if (style.section) { row.fill = SECTION_FILL; row.font = SECTION_FONT; }
  if (style.total) { row.font = TOTAL_FONT; row.getCell(2).numFmt = CURRENCY_FMT; }
  return row;
}

// ─── MAIN EXPORT ────────────────────────────────────────────────
async function generateSettlementExcel(settlementId) {
  const settlement = await col('settlements').findOne({ _id: settlementId });
  if (!settlement) throw new Error('Settlement not found');

  const restaurant = await col('restaurants').findOne(
    { _id: { $in: [settlement.restaurant_id, require('mongodb').ObjectId.createFromHexString?.(settlement.restaurant_id)] } },
    { projection: { business_name: 1, brand_name: 1, commission_pct: 1, city: 1, phone: 1, gst_number: 1, pan_number: 1 } },
  );

  // Fetch orders + items + refunds + payments
  const orders = await col('orders').find({ settlement_id: settlementId }).sort({ created_at: 1 }).toArray();
  const orderIds = orders.map(o => String(o._id));

  const items = await col('order_items').find({ order_id: { $in: orderIds } }).toArray();
  const itemsByOrder = {};
  for (const item of items) (itemsByOrder[item.order_id] ||= []).push(item);

  const refundPayments = await col('payments').find({ order_id: { $in: orderIds }, status: 'refunded' }).toArray();
  const orderPayments = await col('payments').find({ order_id: { $in: orderIds } }).toArray();
  const paymentsByOrder = {};
  for (const p of orderPayments) (paymentsByOrder[p.order_id] ||= []).push(p);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'GullyBite';
  wb.created = new Date();

  const restaurantName = restaurant?.brand_name || restaurant?.business_name || 'Restaurant';
  const commissionPct = parseFloat(restaurant?.commission_pct ?? 0);

  // ══════════════════════════════════════════════════════════════
  // SHEET 1: SUMMARY (Full Tax Breakdown)
  // ══════════════════════════════════════════════════════════════
  const ws1 = wb.addWorksheet('Summary');
  ws1.columns = [
    { header: 'Field', key: 'field', width: 40 },
    { header: 'Value', key: 'value', width: 22 },
  ];

  // Header info
  addSummaryLine(ws1, 'SETTLEMENT SUMMARY — ' + restaurantName, '', false, { section: true });
  addSummaryLine(ws1, 'City', restaurant?.city || '—');
  addSummaryLine(ws1, 'Settlement ID', String(settlementId));
  addSummaryLine(ws1, 'Period Start', settlement.period_start);
  addSummaryLine(ws1, 'Period End', settlement.period_end);
  addSummaryLine(ws1, 'Total Orders', settlement.orders_count);
  addSummaryLine(ws1, '', ''); // spacer

  // Revenue section
  addSummaryLine(ws1, 'REVENUE', '', false, { section: true });
  addSummaryLine(ws1, 'Food Revenue', settlement.food_revenue_rs || round2(settlement.gross_revenue_rs), true);
  addSummaryLine(ws1, 'Food GST Collected (5%)', settlement.food_gst_collected_rs || 0, true);
  addSummaryLine(ws1, 'Packaging Charges', settlement.packaging_collected_rs || 0, true);
  addSummaryLine(ws1, 'Packaging GST (18%)', settlement.packaging_gst_rs || 0, true);
  addSummaryLine(ws1, 'Delivery Fee (Customer Share)', settlement.delivery_fee_collected_rs || 0, true);
  addSummaryLine(ws1, 'GROSS COLLECTIONS', settlement.gross_revenue_rs, true, { bold: true });
  addSummaryLine(ws1, '', '');

  // Deductions section
  addSummaryLine(ws1, 'DEDUCTIONS', '', false, { section: true });
  // Platform fee label adapts to model: legacy commission rows show "%",
  // Phase 5 flat-subscription rows show "Subscription". commissionPct is 0
  // for all post-launch restaurants, signalling the flat model.
  const platformFeeLabel = commissionPct > 0
    ? `Platform Fee (${commissionPct}%)`
    : 'Platform Subscription Fee';
  addSummaryLine(ws1, platformFeeLabel, -(settlement.platform_fee_rs || 0), true);
  addSummaryLine(ws1, `GST (${GST_PLATFORM_FEE_PCT}%) on Platform Fee`, -(settlement.platform_fee_gst_rs || 0), true);
  // Combined subtotal so the merchant sees fee + GST as a single liability.
  // Hidden when both are zero (first month / waived).
  const platformFeeTotal = (settlement.platform_fee_rs || 0) + (settlement.platform_fee_gst_rs || 0);
  if (platformFeeTotal > 0) {
    addSummaryLine(ws1, 'Total Platform Deduction', -platformFeeTotal, true, { bold: true });
  }
  addSummaryLine(ws1, 'Delivery Cost (Restaurant Share)', -(settlement.delivery_fee_restaurant_share_rs || settlement.delivery_costs_rs || 0), true);
  addSummaryLine(ws1, 'Delivery GST (18%)', -(settlement.delivery_fee_restaurant_gst_rs || 0), true);
  addSummaryLine(ws1, 'Coupon Discounts', -(settlement.discount_total_rs || 0), true);
  addSummaryLine(ws1, `Refunds (${settlement.refund_count || refundPayments.length} orders)`, -(settlement.refund_total_rs || settlement.refunds_rs || 0), true);

  if (settlement.tds_applicable) {
    addSummaryLine(ws1, `TDS (${settlement.tds_rate_pct}% u/s ${settlement.tds_section || '194O'})`, -(settlement.tds_amount_rs || 0), true);
  }

  if (settlement.referral_fee_rs) {
    addSummaryLine(ws1, 'Referral Commission', -(settlement.referral_fee_rs || 0), true);
    addSummaryLine(ws1, 'Referral GST (18%)', -(settlement.referral_fee_gst_rs || 0), true);
  }

  const totalDeductions = round2(
    (settlement.platform_fee_rs || 0) + (settlement.platform_fee_gst_rs || 0) +
    (settlement.delivery_fee_restaurant_share_rs || settlement.delivery_costs_rs || 0) +
    (settlement.delivery_fee_restaurant_gst_rs || 0) +
    (settlement.discount_total_rs || 0) + (settlement.refund_total_rs || settlement.refunds_rs || 0) +
    (settlement.tds_amount_rs || 0) + (settlement.referral_fee_rs || 0) + (settlement.referral_fee_gst_rs || 0)
  );
  addSummaryLine(ws1, 'TOTAL DEDUCTIONS', -totalDeductions, true, { bold: true });
  addSummaryLine(ws1, '', '');
  addSummaryLine(ws1, 'NET PAYOUT', settlement.net_payout_rs, true, { total: true });
  addSummaryLine(ws1, '', '');

  // Payout details
  addSummaryLine(ws1, 'PAYOUT DETAILS', '', false, { section: true });
  addSummaryLine(ws1, 'Status', settlement.payout_status);
  addSummaryLine(ws1, 'Razorpay Payout ID', settlement.rp_payout_id || '—');
  addSummaryLine(ws1, 'Bank UTR', settlement.payout_utr || '—');
  addSummaryLine(ws1, 'Payout Date', settlement.payout_completed_at || settlement.payout_at || '—');
  addSummaryLine(ws1, '', '');

  // Tax information
  addSummaryLine(ws1, 'TAX INFORMATION', '', false, { section: true });
  addSummaryLine(ws1, 'Restaurant GSTIN', restaurant?.gst_number || 'Not provided');
  addSummaryLine(ws1, 'Restaurant PAN', restaurant?.pan_number || 'Not provided');
  if (settlement.tds_applicable) {
    addSummaryLine(ws1, 'TDS Section', settlement.tds_section || '194O');
    addSummaryLine(ws1, 'TDS Rate', `${settlement.tds_rate_pct}%`);
    addSummaryLine(ws1, 'TDS Amount', settlement.tds_amount_rs, true);
  }

  // Format date cells
  ws1.eachRow((row, rowNum) => {
    const v = row.getCell(2).value;
    if (v instanceof Date) row.getCell(2).numFmt = DATE_FMT;
  });

  styleHeaders(ws1);
  autoWidth(ws1);

  // ══════════════════════════════════════════════════════════════
  // SHEET 2: ORDER DETAILS (Enhanced)
  // ══════════════════════════════════════════════════════════════
  const ws2 = wb.addWorksheet('Order Details');
  ws2.columns = [
    { header: 'Order #', key: 'order_num', width: 22 },
    { header: 'Date', key: 'date', width: 18 },
    { header: 'Customer', key: 'customer', width: 20 },
    { header: 'Phone', key: 'phone', width: 15 },
    { header: 'Subtotal', key: 'subtotal', width: 12 },
    { header: 'Food GST', key: 'food_gst', width: 12 },
    { header: 'Packaging', key: 'packaging', width: 12 },
    { header: 'Pkg GST', key: 'pkg_gst', width: 10 },
    { header: 'Delivery (Cust)', key: 'cust_delivery', width: 15 },
    { header: 'Del GST (Cust)', key: 'cust_del_gst', width: 15 },
    { header: 'Delivery (Rest)', key: 'rest_delivery', width: 15 },
    { header: 'Del GST (Rest)', key: 'rest_del_gst', width: 15 },
    { header: 'Discount', key: 'discount', width: 12 },
    { header: 'Referral Fee', key: 'referral', width: 12 },
    { header: 'Total', key: 'total', width: 12 },
    { header: 'Platform Fee', key: 'platform_fee', width: 14 },
    { header: 'Payment Method', key: 'pay_method', width: 16 },
    { header: 'Razorpay ID', key: 'rp_id', width: 24 },
    { header: 'Status', key: 'status', width: 12 },
  ];

  for (const order of orders) {
    const pmts = paymentsByOrder[String(order._id)] || [];
    const pmt = pmts.find(p => p.status === 'captured' || p.status === 'paid') || pmts[0];
    ws2.addRow({
      order_num: order.order_number || String(order._id),
      date: order.delivered_at || order.created_at,
      customer: order.customer_name || '—',
      phone: order.customer_phone || '—',
      subtotal: round2(order.subtotal_rs),
      food_gst: round2(order.food_gst_rs),
      packaging: round2(order.packaging_rs),
      pkg_gst: round2(order.packaging_gst_rs),
      cust_delivery: round2(order.customer_delivery_rs),
      cust_del_gst: round2(order.customer_delivery_gst_rs),
      rest_delivery: round2(order.restaurant_delivery_rs),
      rest_del_gst: round2(order.restaurant_delivery_gst_rs),
      discount: round2(order.discount_rs),
      referral: round2(order.referral_fee_rs),
      total: round2(order.total_rs),
      platform_fee: round2((order.subtotal_rs || 0) * commissionPct / 100),
      pay_method: pmt?.method || '—',
      rp_id: pmt?.razorpay_payment_id || pmt?.rp_payment_id || '—',
      status: order.status,
    });
  }

  ws2.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    for (let c = 5; c <= 16; c++) row.getCell(c).numFmt = CURRENCY_FMT;
    row.getCell(2).numFmt = DATETIME_FMT;
  });

  styleHeaders(ws2);
  autoWidth(ws2);

  // ══════════════════════════════════════════════════════════════
  // SHEET 3: ORDER ITEMS
  // ══════════════════════════════════════════════════════════════
  const ws3 = wb.addWorksheet('Order Items');
  ws3.columns = [
    { header: 'Order #', key: 'order_num', width: 22 },
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
      const unitPrice = round2(item.unit_price_rs || item.price_rs || (item.price_paise ? item.price_paise / 100 : 0));
      const qty = item.quantity || item.qty || 1;
      ws3.addRow({
        order_num: order.order_number || String(order._id),
        name: item.name || item.item_name || '—',
        variant: item.variant_value || '—',
        qty,
        unit_price: unitPrice,
        line_total: round2(item.line_total_rs || unitPrice * qty),
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

  // ══════════════════════════════════════════════════════════════
  // SHEET 4: REFUNDS
  // ══════════════════════════════════════════════════════════════
  const ws4 = wb.addWorksheet('Refunds');
  ws4.columns = [
    { header: 'Order #', key: 'order_num', width: 22 },
    { header: 'Date', key: 'date', width: 18 },
    { header: 'Amount', key: 'amount', width: 12 },
    { header: 'Razorpay Refund ID', key: 'rp_id', width: 28 },
    { header: 'Reason', key: 'reason', width: 30 },
    { header: 'Issue #', key: 'issue', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
  ];

  if (refundPayments.length) {
    for (const p of refundPayments) {
      const order = orders.find(o => String(o._id) === p.order_id);
      ws4.addRow({
        order_num: order?.order_number || p.order_id || '—',
        date: p.updated_at || p.created_at,
        amount: round2(p.amount_rs),
        rp_id: p.rp_refund_id || p.razorpay_refund_id || p.rp_payment_id || '—',
        reason: p.refund_reason || '—',
        issue: p.issue_number || '—',
        status: p.status,
      });
    }
  } else {
    ws4.addRow({ order_num: 'No refunds in this period' });
    ws4.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };
  }

  ws4.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    row.getCell(2).numFmt = DATETIME_FMT;
    row.getCell(3).numFmt = CURRENCY_FMT;
  });
  styleHeaders(ws4);
  autoWidth(ws4);

  // ══════════════════════════════════════════════════════════════
  // SHEET 5: TAX SUMMARY
  // ══════════════════════════════════════════════════════════════
  const ws5 = wb.addWorksheet('Tax Summary');
  ws5.columns = [
    { header: 'Month', key: 'month', width: 12 },
    { header: 'Food GST', key: 'food_gst', width: 14 },
    { header: 'Packaging GST', key: 'pkg_gst', width: 14 },
    { header: 'Delivery GST', key: 'del_gst', width: 14 },
    { header: 'Platform Fee GST', key: 'pf_gst', width: 16 },
    { header: 'Total GST', key: 'total', width: 14 },
  ];

  try {
    const taxData = await getTaxSummary(settlement.restaurant_id);
    for (const m of taxData.gst_monthly) {
      ws5.addRow({
        month: m.month,
        food_gst: m.food_gst_rs,
        pkg_gst: m.packaging_gst_rs,
        del_gst: m.delivery_gst_rs,
        pf_gst: m.platform_fee_gst_rs,
        total: m.total_gst_rs,
      });
    }
    // Total row
    const totals = taxData.gst_monthly.reduce((a, m) => ({
      food: a.food + m.food_gst_rs,
      pkg: a.pkg + m.packaging_gst_rs,
      del: a.del + m.delivery_gst_rs,
      pf: a.pf + m.platform_fee_gst_rs,
      total: a.total + m.total_gst_rs,
    }), { food: 0, pkg: 0, del: 0, pf: 0, total: 0 });

    const totalRow = ws5.addRow({
      month: 'TOTAL', food_gst: round2(totals.food), pkg_gst: round2(totals.pkg),
      del_gst: round2(totals.del), pf_gst: round2(totals.pf), total: round2(totals.total),
    });
    totalRow.font = { bold: true };

    // Add TDS summary below with a gap
    ws5.addRow({});
    ws5.addRow({});
    const tdsHeader = ws5.addRow({ month: 'TDS DEDUCTIONS', food_gst: '', pkg_gst: '', del_gst: '', pf_gst: '', total: '' });
    tdsHeader.font = SECTION_FONT;
    tdsHeader.fill = SECTION_FILL;

    if (taxData.tds_entries.length) {
      ws5.addRow({ month: 'Period', food_gst: 'Gross Payout', pkg_gst: 'TDS Rate', del_gst: 'TDS Amount', pf_gst: 'Section', total: '' });
      for (const t of taxData.tds_entries) {
        ws5.addRow({ month: t.period, food_gst: t.gross_payout_rs, pkg_gst: t.tds_rate_pct + '%', del_gst: t.tds_amount_rs, pf_gst: t.section, total: '' });
      }
      const tdsTotal = ws5.addRow({ month: 'FY TOTAL TDS', food_gst: '', pkg_gst: '', del_gst: taxData.tds_total_rs, pf_gst: '', total: '' });
      tdsTotal.font = { bold: true };
    } else {
      ws5.addRow({ month: 'No TDS deducted in this FY' });
    }

    // Add cumulative payout info
    ws5.addRow({});
    ws5.addRow({ month: 'Cumulative FY Payouts:', food_gst: taxData.cumulative_payouts_rs });
    ws5.addRow({ month: 'GSTIN on file:', food_gst: taxData.gst_number || 'Not provided' });
    ws5.addRow({ month: 'PAN on file:', food_gst: taxData.pan_number || 'Not provided' });
  } catch {
    ws5.addRow({ month: 'Tax data unavailable' });
    ws5.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };
  }

  ws5.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    for (let c = 2; c <= 6; c++) {
      const v = row.getCell(c).value;
      if (typeof v === 'number') row.getCell(c).numFmt = CURRENCY_FMT;
    }
  });
  styleHeaders(ws5);
  autoWidth(ws5);

  // ══════════════════════════════════════════════════════════════
  // SHEET 6: MESSAGING COSTS
  // ══════════════════════════════════════════════════════════════
  const ws6 = wb.addWorksheet('Messaging Costs');
  ws6.columns = [
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Messages', key: 'count', width: 12 },
    { header: 'Rate (₹)', key: 'rate', width: 12 },
    { header: 'Cost (₹)', key: 'cost', width: 14 },
  ];

  try {
    const msgTracking = require('./messageTracking');
    const breakdown = await msgTracking.getCostBreakdown(settlement.restaurant_id, {
      from: settlement.period_start,
      to: settlement.period_end,
    });
    let totalMsgCost = 0;
    for (const b of breakdown) {
      ws6.addRow({
        category: b.category.charAt(0).toUpperCase() + b.category.slice(1),
        count: b.count,
        rate: msgTracking.MESSAGING_RATES[b.category] || 0,
        cost: round2(b.cost_rs),
      });
      totalMsgCost += b.cost_rs;
    }
    const totalRow = ws6.addRow({ category: 'TOTAL', count: '', rate: '', cost: round2(totalMsgCost) });
    totalRow.font = { bold: true };
    ws6.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      row.getCell(3).numFmt = CURRENCY_FMT;
      row.getCell(4).numFmt = CURRENCY_FMT;
    });
  } catch {
    ws6.addRow({ category: 'No messaging data available' });
    ws6.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };
  }
  styleHeaders(ws6);
  autoWidth(ws6);

  // ── RETURN BUFFER ─────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  return {
    buffer,
    filename: `Settlement_${restaurantName.replace(/[^a-zA-Z0-9]/g, '_')}_${settlement.period_start.toISOString().split('T')[0]}.xlsx`,
  };
}

module.exports = { generateSettlementExcel };
