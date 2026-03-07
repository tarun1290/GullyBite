'use strict';

/**
 * GullyBite — Order Charge Calculator
 *
 * Given a restaurant's charge configuration and an order's subtotal + discount,
 * returns a complete breakdown of every charge line item:
 *   - Food GST (only when menu_gst_mode = 'extra')
 *   - Delivery fee split: customer portion + GST, restaurant portion + GST
 *   - Packaging charge + GST
 *   - Customer total (what they pay)
 *   - Restaurant deduction (delivery share to be withheld at settlement)
 *
 * All monetary values are rounded to 2 decimal places.
 */

const DELIVERY_GST_PCT = 18;

/**
 * @param {object} restaurantConfig
 * @param {number}  restaurantConfig.delivery_fee_customer_pct  0-100
 * @param {string}  restaurantConfig.menu_gst_mode              'included'|'extra'
 * @param {number}  restaurantConfig.menu_gst_pct               e.g. 5
 * @param {number}  restaurantConfig.packaging_charge_rs        e.g. 20
 * @param {number}  restaurantConfig.packaging_gst_pct          e.g. 18
 *
 * @param {number} subtotalRs       Sum of (item price × qty) using listed menu prices
 * @param {number} deliveryFeeRs    Full delivery fee before split (from branch or platform)
 * @param {number} discountRs       Coupon/promo discount already calculated (≥ 0)
 *
 * @returns {object} Full charge breakdown
 */
function calculateOrderCharges(restaurantConfig, subtotalRs, deliveryFeeRs = 0, discountRs = 0) {
  const {
    delivery_fee_customer_pct = 100,
    menu_gst_mode             = 'included',
    menu_gst_pct              = 5,
    packaging_charge_rs       = 0,
    packaging_gst_pct         = 18,
  } = restaurantConfig;

  const round2 = (n) => Math.round(n * 100) / 100;

  // ── Food GST ──────────────────────────────────────────────────
  // 'included': GST is baked into menu prices; no extra line shown.
  // 'extra'   : GST is added on top and shown separately at checkout.
  const foodGstRs = menu_gst_mode === 'extra'
    ? round2(subtotalRs * (menu_gst_pct / 100))
    : 0;

  // ── Delivery fee split ────────────────────────────────────────
  const deliveryTotal      = round2(deliveryFeeRs);
  const customerDeliveryRs = round2(deliveryTotal * (delivery_fee_customer_pct / 100));
  const restaurantDeliveryRs = round2(deliveryTotal - customerDeliveryRs);

  const customerDeliveryGstRs  = round2(customerDeliveryRs  * (DELIVERY_GST_PCT / 100));
  const restaurantDeliveryGstRs = round2(restaurantDeliveryRs * (DELIVERY_GST_PCT / 100));

  // ── Packaging ─────────────────────────────────────────────────
  const packagingRs    = round2(Number(packaging_charge_rs) || 0);
  const packagingGstRs = round2(packagingRs * (packaging_gst_pct / 100));

  // ── Customer total ────────────────────────────────────────────
  const discount  = round2(Number(discountRs) || 0);
  const customerTotal = round2(
    subtotalRs
    + foodGstRs
    + customerDeliveryRs + customerDeliveryGstRs
    + packagingRs        + packagingGstRs
    - discount
  );

  // ── Restaurant deduction at settlement ────────────────────────
  // Restaurant absorbs their delivery share + GST on that share.
  const restaurantDeductionRs = round2(restaurantDeliveryRs + restaurantDeliveryGstRs);

  return {
    // Inputs (normalised)
    subtotal_rs:                   round2(subtotalRs),
    discount_rs:                   discount,
    delivery_fee_total_rs:         deliveryTotal,

    // Food GST
    food_gst_rs:                   foodGstRs,

    // Delivery split
    customer_delivery_rs:          customerDeliveryRs,
    customer_delivery_gst_rs:      customerDeliveryGstRs,
    restaurant_delivery_rs:        restaurantDeliveryRs,
    restaurant_delivery_gst_rs:    restaurantDeliveryGstRs,

    // Packaging
    packaging_rs:                  packagingRs,
    packaging_gst_rs:              packagingGstRs,

    // Totals
    customer_total_rs:             customerTotal,
    restaurant_delivery_deduction_rs: restaurantDeductionRs,
  };
}

/**
 * Formats a charge breakdown into a WhatsApp-friendly text block.
 * Each line is padded with dots for alignment (monospace-friendly).
 *
 * @param {object} breakdown  Result of calculateOrderCharges()
 * @param {string} menuGstMode  'included'|'extra'
 * @returns {string}
 */
function formatChargeBreakdown(breakdown, menuGstMode = 'included') {
  const lines = [];
  const fmt = (label, rs) => `${label.padEnd(28, '.')} ₹${rs.toFixed(2)}`;

  lines.push(fmt('Subtotal', breakdown.subtotal_rs));

  if (menuGstMode === 'extra' && breakdown.food_gst_rs > 0) {
    lines.push(fmt('Food GST (5%)', breakdown.food_gst_rs));
  }

  if (breakdown.customer_delivery_rs > 0) {
    lines.push(fmt('Delivery', breakdown.customer_delivery_rs));
    lines.push(fmt('Delivery GST (18%)', breakdown.customer_delivery_gst_rs));
  }

  if (breakdown.packaging_rs > 0) {
    lines.push(fmt('Packaging', breakdown.packaging_rs));
    if (breakdown.packaging_gst_rs > 0) {
      lines.push(fmt('Packaging GST', breakdown.packaging_gst_rs));
    }
  }

  if (breakdown.discount_rs > 0) {
    lines.push(fmt('Discount', -breakdown.discount_rs));
  }

  lines.push('─'.repeat(36));
  lines.push(fmt('*Total*', breakdown.customer_total_rs));

  return lines.join('\n');
}

module.exports = { calculateOrderCharges, formatChargeBreakdown };
