// src/services/campaigns.js
// Multi-Product Message (MPM) marketing campaigns
// Sends WhatsApp catalog product lists to customer segments
//
// [WhatsApp2026] Portfolio Pacing: Meta batches marketing sends and monitors
// customer feedback. GullyBite adds its own gradual sending + health monitoring.
//
// Collection: campaigns
//   { _id, restaurant_id, branch_id, name, product_ids[], segment, schedule_at,
//     status (draft|scheduled|sending|paused|sent|failed), batch_size,
//     stats: { total_recipients, sent, delivered, read, failed, failed_pacing, failed_24h },
//     current_batch, total_batches, resume_from_index,
//     header_text, body_text, footer_text, created_at, sent_at, paused_at }

'use strict';

const { col, newId } = require('../config/database');
const wa = require('./whatsapp');

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_BATCH_DELAY_MS = 5000;
const FAILURE_THRESHOLD_PCT = 10; // Auto-pause if >10% fail in a batch

// ─── CREATE CAMPAIGN ────────────────────────────────────────────
async function createCampaign(restaurantId, data) {
  const { branchId, name, productIds, segment, headerText, bodyText, footerText, scheduleAt, batchSize } = data;

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
    batch_size: parseInt(batchSize) || DEFAULT_BATCH_SIZE,
    stats: { total_recipients: 0, sent: 0, delivered: 0, read: 0, failed: 0, failed_pacing: 0, failed_24h: 0 },
    current_batch: 0,
    total_batches: 0,
    resume_from_index: 0,
    created_at: new Date(),
    sent_at: null,
    paused_at: null,
  };

  await col('campaigns').insertOne(campaign);
  return campaign;
}

// ─── SEND CAMPAIGN (with batched pacing) ───────────────────────
async function sendCampaign(campaignId, { resuming = false } = {}) {
  const campaign = await col('campaigns').findOne({ _id: campaignId });
  if (!campaign) throw new Error('Campaign not found');

  if (!resuming && (campaign.status === 'sending' || campaign.status === 'sent')) {
    throw new Error('Campaign already sent or in progress');
  }
  if (resuming && campaign.status !== 'paused') {
    throw new Error('Campaign is not paused');
  }

  await col('campaigns').updateOne({ _id: campaignId }, {
    $set: { status: 'sending', paused_at: null },
  });

  try {
    const waAccount = await col('whatsapp_accounts').findOne({
      restaurant_id: campaign.restaurant_id,
      is_active: true,
    });
    if (!waAccount) throw new Error('No active WhatsApp account');

    const customers = await getSegmentCustomers(campaign.restaurant_id, campaign.segment);
    const totalRecipients = customers.length;

    if (!totalRecipients) {
      await col('campaigns').updateOne({ _id: campaignId }, {
        $set: { status: 'sent', sent_at: new Date(), 'stats.total_recipients': 0 },
      });
      return { sent: 0, failed: 0, total: 0 };
    }

    const products = await col('menu_items').find({
      _id: { $in: campaign.product_ids },
      branch_id: campaign.branch_id,
      retailer_id: { $exists: true, $ne: null },
    }).toArray();

    if (!products.length) throw new Error('No valid products with retailer_id found');

    const catalogId = waAccount.catalog_id;
    if (!catalogId) throw new Error('Restaurant has no WhatsApp catalog connected');

    const batchSize = campaign.batch_size || DEFAULT_BATCH_SIZE;
    const totalBatches = Math.ceil(totalRecipients / batchSize);
    const startIndex = resuming ? (campaign.resume_from_index || 0) : 0;

    await col('campaigns').updateOne({ _id: campaignId }, {
      $set: { 'stats.total_recipients': totalRecipients, total_batches: totalBatches },
    });

    let sent = campaign.stats?.sent || 0;
    let failed = campaign.stats?.failed || 0;
    let failedPacing = campaign.stats?.failed_pacing || 0;
    let failed24h = campaign.stats?.failed_24h || 0;

    for (let i = startIndex; i < totalRecipients; i += batchSize) {
      // Check if campaign was paused by admin between batches
      const freshCampaign = await col('campaigns').findOne({ _id: campaignId });
      if (freshCampaign.status === 'paused') {
        console.log(`[Campaign] ${campaignId} paused by admin at index ${i}`);
        return { sent, failed, paused: true, resume_from: i };
      }

      const batch = customers.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      let batchFailed = 0;

      for (const customer of batch) {
        try {
          const toId = customer.wa_phone || customer.bsuid;
          if (!toId) { failed++; batchFailed++; continue; }
          const result = await sendMPM(
            waAccount.phone_number_id,
            waAccount.access_token,
            toId,
            catalogId,
            products,
            campaign
          );
          sent++;

          // Store message ID for delivery tracking
          const msgId = result?.messages?.[0]?.id;
          if (msgId) {
            await col('campaign_messages').updateOne(
              { message_id: msgId },
              { $setOnInsert: {
                _id: newId(), message_id: msgId, campaign_id: campaignId,
                customer_id: String(customer._id), status: 'sent', created_at: new Date(),
              }},
              { upsert: true }
            );
          }
        } catch (err) {
          failed++;
          batchFailed++;
          const errCode = err.response?.data?.error?.code;
          if (errCode === 131049) failedPacing++;   // Pacing limit
          if (errCode === 131026) failed24h++;       // Outside 24h window
          console.error(`[Campaign] Batch ${batchNum}: Failed to send to ${customer.wa_phone || customer.bsuid}: code=${errCode} msg=${err.response?.data?.error?.message || err.message}`);
        }

        // Rate limit within batch: ~20 msgs/sec
        if ((sent + failed) % 20 === 0) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Update stats after each batch
      await col('campaigns').updateOne({ _id: campaignId }, {
        $set: {
          'stats.sent': sent,
          'stats.failed': failed,
          'stats.failed_pacing': failedPacing,
          'stats.failed_24h': failed24h,
          current_batch: batchNum,
          resume_from_index: i + batchSize,
        },
      });

      // [WhatsApp2026] Health check: auto-pause if failure rate too high
      if (batchFailed > 0 && batch.length > 0) {
        const batchFailRate = (batchFailed / batch.length) * 100;
        if (batchFailRate > FAILURE_THRESHOLD_PCT) {
          console.warn(`[Campaign] ${campaignId} auto-paused: ${batchFailRate.toFixed(1)}% failure rate in batch ${batchNum}`);
          await col('campaigns').updateOne({ _id: campaignId }, {
            $set: {
              status: 'paused',
              paused_at: new Date(),
              pause_reason: `Auto-paused: ${batchFailRate.toFixed(1)}% failure rate in batch ${batchNum}. ${failedPacing > 0 ? `Meta pacing errors: ${failedPacing}.` : ''} Review and resume when ready.`,
            },
          });
          return { sent, failed, paused: true, auto_paused: true, resume_from: i + batchSize };
        }
      }

      // Delay between batches
      if (i + batchSize < totalRecipients) {
        await new Promise(r => setTimeout(r, DEFAULT_BATCH_DELAY_MS));
      }
    }

    await col('campaigns').updateOne({ _id: campaignId }, {
      $set: {
        status: 'sent',
        'stats.sent': sent,
        'stats.failed': failed,
        'stats.failed_pacing': failedPacing,
        'stats.failed_24h': failed24h,
        sent_at: new Date(),
      },
    });

    return { sent, failed };
  } catch (err) {
    await col('campaigns').updateOne({ _id: campaignId }, {
      $set: { status: 'failed', sent_at: new Date() },
    });
    throw err;
  }
}

// ─── PAUSE CAMPAIGN ─────────────────────────────────────────────
async function pauseCampaign(campaignId, restaurantId) {
  const campaign = await col('campaigns').findOne({ _id: campaignId });
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.restaurant_id !== restaurantId) throw new Error('Not your campaign');
  if (campaign.status !== 'sending') throw new Error('Campaign is not currently sending');

  await col('campaigns').updateOne({ _id: campaignId }, {
    $set: { status: 'paused', paused_at: new Date(), pause_reason: 'Paused by admin' },
  });
  return { ok: true };
}

// ─── RESUME CAMPAIGN ────────────────────────────────────────────
async function resumeCampaign(campaignId, restaurantId) {
  const campaign = await col('campaigns').findOne({ _id: campaignId });
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.restaurant_id !== restaurantId) throw new Error('Not your campaign');
  if (campaign.status !== 'paused') throw new Error('Campaign is not paused');

  // Resume sending in background
  sendCampaign(campaignId, { resuming: true }).catch(err => {
    console.error(`[Campaign] Resume failed for ${campaignId}:`, err.message);
  });
  return { ok: true, resuming_from: campaign.resume_from_index };
}

// ─── TRACK CAMPAIGN MESSAGE STATUS (from webhook) ──────────────
// [WhatsApp2026] Called when WhatsApp status webhooks arrive for campaign messages
async function trackMessageStatus(messageId, status) {
  const msg = await col('campaign_messages').findOne({ message_id: messageId });
  if (!msg) return false;

  // Update individual message status
  await col('campaign_messages').updateOne(
    { message_id: messageId },
    { $set: { status, updated_at: new Date() } }
  );

  // Increment campaign stats
  const field = status === 'delivered' ? 'stats.delivered'
    : status === 'read' ? 'stats.read'
    : status === 'failed' ? 'stats.failed'
    : null;

  if (field) {
    await col('campaigns').updateOne(
      { _id: msg.campaign_id },
      { $inc: { [field]: 1 } }
    );
  }

  return true;
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
  // [BSUID] Target customers who have at least one reachable identifier
  const filter = { restaurant_id: restaurantId, $or: [{ wa_phone: { $exists: true, $ne: null } }, { bsuid: { $exists: true, $ne: null } }] };

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

  return col('customers').find(filter).project({ wa_phone: 1, bsuid: 1, name: 1 }).toArray();
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
  pauseCampaign,
  resumeCampaign,
  trackMessageStatus,
  getCampaigns,
  getDueCampaigns,
  deleteCampaign,
};
