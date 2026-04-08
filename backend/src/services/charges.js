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
// Delegates to the centralized financial engine — single source of truth for all calculations.
// This wrapper preserves the existing function signature for backward compatibility.
function calculateOrderCharges(restaurantConfig, subtotalRs, deliveryFeeRs = 0, discountRs = 0) {
  const { calculateCheckout } = require('../core/financialEngine');
  return calculateCheckout(restaurantConfig, subtotalRs, deliveryFeeRs, discountRs);
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
