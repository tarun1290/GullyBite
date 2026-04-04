// src/config/cart-recovery-config.js
// Configuration for abandoned cart detection and recovery campaigns.
// Adjust these values without redeploying by using platform_settings overrides.

'use strict';

const CART_RECOVERY_CONFIG = {
  // Reminder timing (minutes after abandonment)
  reminder_1_delay_minutes: 30,
  reminder_2_delay_minutes: 240,      // 4 hours
  reminder_3_delay_minutes: 1440,     // 24 hours

  // Reminder 3 uses a paid Meta template (~₹0.48 per message)
  // Set to true after the template is approved in Meta Business Manager
  reminder_3_enabled: false,
  // FUTURE FEATURE: Template name: 'cart_recovery_reminder'
  // Category: MARKETING, Language: en
  // Body: "Hi {{1}}, you left {{2}} items (₹{{3}}) in your cart at {{4}}. Your favorites are waiting — reply to complete your order! 🍽️"
  // Footer: "Reply STOP to opt out"
  // Variables: 1=customer_name, 2=item_count, 3=cart_total, 4=restaurant_name
  reminder_3_template_name: 'cart_recovery_reminder',

  // Limits
  max_reminders_per_cron_run: 50,
  min_cart_value_rs: 50,              // don't send recovery for carts under ₹50
  cart_expiry_days: 7,

  // Behavior
  operating_hours_check: true,        // respect restaurant hours before sending
  earliest_send_hour: 8,             // IST — don't send before 8 AM
  latest_send_hour: 22,              // IST — don't send after 10 PM
};

module.exports = CART_RECOVERY_CONFIG;
