'use strict';

// Campaign attribution for orders.
// When an order is placed, find the most recent marketing send to that
// customer's phone within ATTRIBUTION_WINDOW_HOURS. If the send carried
// a campaign_id, credit the order to that campaign.
//
// Safety rules (step 8 of the spec):
//   • Pick only the *single* most recent campaign send → no double
//     attribution when multiple campaigns reached the same phone.
//   • Hard window — nothing older than ATTRIBUTION_WINDOW_HOURS counts.
//   • Primary source is campaign_messages (written at send time); if the
//     campaign send never got a pricing webhook, marketing_messages might
//     not have a campaign_id yet — campaign_messages is authoritative.

const { col } = require('../config/database');
const { hashPhone } = require('../utils/phoneHash');

const ATTRIBUTION_WINDOW_HOURS = Number(process.env.CAMPAIGN_ATTRIBUTION_WINDOW_HOURS) || 24;

async function findAttribution({ restaurantId, waPhone }) {
  if (!restaurantId || !waPhone) return null;
  const phoneHash = hashPhone(waPhone);
  if (!phoneHash) return null;

  const cutoff = new Date(Date.now() - ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000);

  const row = await col('campaign_messages').findOne(
    {
      restaurant_id: restaurantId,
      phone_hash: phoneHash,
      campaign_id: { $ne: null },
      sent_at: { $gte: cutoff },
    },
    { sort: { sent_at: -1 }, projection: { campaign_id: 1, message_id: 1, sent_at: 1 } },
  );

  if (!row) return null;
  return {
    campaign_id: row.campaign_id,
    message_id: row.message_id || null,
    sent_at: row.sent_at || null,
  };
}

module.exports = { findAttribution, ATTRIBUTION_WINDOW_HOURS };
