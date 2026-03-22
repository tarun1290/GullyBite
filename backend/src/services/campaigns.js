// src/services/campaigns.js
// Multi-Product Message (MPM) marketing campaigns
// Sends WhatsApp catalog product lists to customer segments
//
// Collection: campaigns
//   { _id, restaurant_id, branch_id, name, product_ids[], segment, schedule_at,
//     status (draft|scheduled|sending|sent|failed), sent_count, failed_count,
//     header_text, body_text, footer_text, created_at, sent_at }

'use strict';

const { col, newId } = require('../config/database');
const wa = require('./whatsapp');

// ─── CREATE CAMPAIGN ────────────────────────────────────────────
async function createCampaign(restaurantId, data) {
  const { branchId, name, productIds, segment, headerText, bodyText, footerText, scheduleAt } = data;

  if (!branchId || !productIds?.length) {
    throw new Error('branchId and at least one productId are required');
  }

  if (productIds.length > 30) {
    throw new Error('Maximum 30 products per MPM campaign');
  }

  const campaign = {
    _id: newId(),
    restaurant_id: restaurantId,
    branch_id: branchId,
    name: name || 'Untitled Campaign',
    product_ids: productIds,
    segment: segment || 'all', // all | recent | inactive | custom
    header_text: headerText || null,
    body_text: bodyText || 'Check out our latest picks! Tap below to browse and order.',
    footer_text: footerText || 'GullyBite — Order on WhatsApp',
    schedule_at: scheduleAt ? new Date(scheduleAt) : null,
    status: scheduleAt ? 'scheduled' : 'draft',
    sent_count: 0,
    failed_count: 0,
    created_at: new Date(),
    sent_at: null,
  };

  await col('campaigns').insertOne(campaign);
  return campaign;
}

// ─── SEND CAMPAIGN NOW ──────────────────────────────────────────
async function sendCampaign(campaignId) {
  const campaign = await col('campaigns').findOne({ _id: campaignId });
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.status === 'sending' || campaign.status === 'sent') {
    throw new Error('Campaign already sent or in progress');
  }

  await col('campaigns').updateOne({ _id: campaignId }, { $set: { status: 'sending' } });

  try {
    // Get restaurant's WA account
    const waAccount = await col('whatsapp_accounts').findOne({
      restaurant_id: campaign.restaurant_id,
      is_active: true,
    });
    if (!waAccount) throw new Error('No active WhatsApp account');

    // Get target customers
    const customers = await getSegmentCustomers(campaign.restaurant_id, campaign.segment);
    if (!customers.length) {
      await col('campaigns').updateOne({ _id: campaignId }, { $set: { status: 'sent', sent_at: new Date() } });
      return { sent: 0, failed: 0 };
    }

    // Validate products exist and have retailer_id
    const products = await col('menu_items').find({
      _id: { $in: campaign.product_ids },
      branch_id: campaign.branch_id,
      retailer_id: { $exists: true, $ne: null },
    }).toArray();

    if (!products.length) throw new Error('No valid products with retailer_id found');

    // Build MPM catalog sections
    const catalogId = waAccount.catalog_id;
    if (!catalogId) throw new Error('Restaurant has no WhatsApp catalog connected');

    let sent = 0, failed = 0;

    for (const customer of customers) {
      try {
        await sendMPM(
          waAccount.phone_number_id,
          waAccount.access_token,
          customer.wa_phone,
          catalogId,
          products,
          campaign
        );
        sent++;
      } catch (err) {
        failed++;
        console.error(`[Campaign] Failed to send to ${customer.wa_phone}:`, err.message);
      }

      // Rate limit: ~20 msgs/sec to avoid Meta throttling
      if ((sent + failed) % 20 === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    await col('campaigns').updateOne({ _id: campaignId }, {
      $set: { status: 'sent', sent_count: sent, failed_count: failed, sent_at: new Date() },
    });

    return { sent, failed };
  } catch (err) {
    await col('campaigns').updateOne({ _id: campaignId }, {
      $set: { status: 'failed', sent_at: new Date() },
    });
    throw err;
  }
}

// ─── SEND MPM MESSAGE ───────────────────────────────────────────
async function sendMPM(pid, token, to, catalogId, products, campaign) {
  // Group into sections of 10 (Meta limit: 10 sections, 30 products total)
  const sections = [];
  for (let i = 0; i < products.length; i += 10) {
    const chunk = products.slice(i, i + 10);
    sections.push({
      title: chunk.length < products.length ? `Products ${i + 1}-${i + chunk.length}` : 'Our Picks',
      product_items: chunk.map(p => ({ product_retailer_id: p.retailer_id })),
    });
  }

  const body = {
    type: 'interactive',
    interactive: {
      type: 'product_list',
      header: { type: 'text', text: (campaign.header_text || campaign.name).substring(0, 60) },
      body: { text: (campaign.body_text || 'Check out these items!').substring(0, 1024) },
      footer: { text: (campaign.footer_text || '').substring(0, 60) },
      action: {
        catalog_id: catalogId,
        sections,
      },
    },
  };

  return wa.sendMsg(pid, token, to, body);
}

// ─── GET SEGMENT CUSTOMERS ──────────────────────────────────────
async function getSegmentCustomers(restaurantId, segment) {
  const filter = { restaurant_id: restaurantId, wa_phone: { $exists: true, $ne: null } };

  switch (segment) {
    case 'recent': {
      // Ordered in last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      filter.last_order_at = { $gte: thirtyDaysAgo };
      break;
    }
    case 'inactive': {
      // No order in last 60 days
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      filter.$or = [
        { last_order_at: { $lt: sixtyDaysAgo } },
        { last_order_at: null },
      ];
      break;
    }
    case 'all':
    default:
      break;
  }

  return col('customers').find(filter).project({ wa_phone: 1, name: 1 }).toArray();
}

// ─── GET CAMPAIGNS ──────────────────────────────────────────────
async function getCampaigns(restaurantId) {
  return col('campaigns')
    .find({ restaurant_id: restaurantId })
    .sort({ created_at: -1 })
    .limit(50)
    .toArray();
}

// ─── GET SCHEDULED (for cron) ───────────────────────────────────
async function getDueCampaigns() {
  return col('campaigns').find({
    status: 'scheduled',
    schedule_at: { $lte: new Date() },
  }).toArray();
}

// ─── DELETE CAMPAIGN ────────────────────────────────────────────
async function deleteCampaign(campaignId, restaurantId) {
  const campaign = await col('campaigns').findOne({ _id: campaignId });
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.restaurant_id !== restaurantId) throw new Error('Not your campaign');
  if (campaign.status === 'sending') throw new Error('Cannot delete while sending');
  await col('campaigns').deleteOne({ _id: campaignId });
}

module.exports = {
  createCampaign,
  sendCampaign,
  getCampaigns,
  getDueCampaigns,
  deleteCampaign,
};
