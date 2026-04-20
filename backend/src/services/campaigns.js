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
const { logActivity } = require('./activityLog');
const { hashPhone } = require('../utils/phoneHash');
const { MESSAGING_RATES } = require('./messageTracking');
const log = require('../utils/logger').child({ component: 'Campaign' });

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_BATCH_DELAY_MS = 5000;
const FAILURE_THRESHOLD_PCT = 10; // Auto-pause if >10% fail in a batch

// CRIT-2B-10: per-restaurant daily cap. Prevents a single tenant from burning
// through the messaging wallet or tripping Meta rate limits via runaway sends.
// Default can be overridden platform-wide via CAMPAIGN_DEFAULT_DAILY_CAP and
// per-restaurant via restaurants.campaign_daily_cap.
const CAMPAIGN_DEFAULT_DAILY_CAP = Number(process.env.CAMPAIGN_DEFAULT_DAILY_CAP) || 3;
const CAMPAIGN_DAILY_CACHE_TTL_SEC = 25 * 3600; // 25h — overlaps midnight safely
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

function _istDateKey(now = new Date()) {
  // YYYY-MM-DD in IST — used as the bucket key so the counter resets at
  // IST midnight regardless of server timezone.
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

function _nextIstMidnight(now = new Date()) {
  // Start of tomorrow in IST, returned in UTC. Used for the 'resets_at'
  // hint surfaced to the dashboard.
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  return new Date(Date.UTC(y, m, d + 1) - IST_OFFSET_MS);
}

function _dailyCapKey(restaurantId) {
  return `campaign_daily:${restaurantId}:${_istDateKey()}`;
}

async function _getConfiguredCap(restaurantId) {
  try {
    const r = await col('restaurants').findOne(
      { _id: restaurantId },
      { projection: { campaign_daily_cap: 1 } },
    );
    if (r && Number.isFinite(Number(r.campaign_daily_cap)) && Number(r.campaign_daily_cap) >= 0) {
      return Number(r.campaign_daily_cap);
    }
  } catch (_) { /* fall through */ }
  return CAMPAIGN_DEFAULT_DAILY_CAP;
}

async function _getSentTodayCount(restaurantId) {
  try {
    const doc = await col('_cache').findOne({ _id: _dailyCapKey(restaurantId) });
    return Number(doc?.value?.count) || 0;
  } catch (_) { return 0; }
}

async function _bumpSentTodayCount(restaurantId) {
  try {
    const key = _dailyCapKey(restaurantId);
    const expiresAt = new Date(Date.now() + CAMPAIGN_DAILY_CACHE_TTL_SEC * 1000);
    await col('_cache').updateOne(
      { _id: key },
      {
        $inc: { 'value.count': 1 },
        $set: { expiresAt, updatedAt: new Date() },
      },
      { upsert: true },
    );
  } catch (err) {
    log.warn({ err, restaurantId }, 'campaign daily counter bump failed');
  }
}

// Public: powers GET /campaigns/daily-usage on the restaurant dashboard.
async function getDailyUsage(restaurantId) {
  const [sentToday, cap] = await Promise.all([
    _getSentTodayCount(restaurantId),
    _getConfiguredCap(restaurantId),
  ]);
  return {
    sent_today: sentToday,
    daily_cap: cap,
    resets_at: _nextIstMidnight().toISOString(),
  };
}

// ─── CREATE CAMPAIGN ────────────────────────────────────────────
// Segment types:
//   all | recent | inactive              — time-based (customers collection)
//   tag (match ALL) | any_tag (match ANY) — tag-based (customer_metrics.tags,
//                                           restaurant-scoped via restaurant_stats)
// Tags are written by customerIdentityLayer.classify: new|repeat|loyal|dormant|high_value.
const TAG_SEGMENTS = new Set(['tag', 'any_tag']);

async function createCampaign(restaurantId, data) {
  const { branchId, name, productIds, segment, tags, tagMatchMode, headerText, bodyText, footerText, scheduleAt, batchSize, sendMethod, couponId } = data;

  if (!branchId || !productIds?.length) {
    throw new Error('branchId and at least one productId are required');
  }

  if (productIds.length > 30) {
    throw new Error('Maximum 30 products per MPM campaign');
  }

  const normalizedSegment = segment || 'all';
  let normalizedTags = null;
  if (TAG_SEGMENTS.has(normalizedSegment)) {
    if (!Array.isArray(tags) || !tags.length) {
      throw new Error('At least one tag is required for tag-based campaigns');
    }
    normalizedTags = [...new Set(tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))];
    if (!normalizedTags.length) throw new Error('At least one tag is required for tag-based campaigns');
  }

  const campaign = {
    _id: newId(),
    restaurant_id: restaurantId,
    branch_id: branchId,
    name: name || 'Untitled Campaign',
    product_ids: productIds,
    segment: normalizedSegment, // all | recent | inactive | tag | any_tag | custom
    tags: normalizedTags,
    tag_match_mode: normalizedSegment === 'tag' ? 'all'
      : normalizedSegment === 'any_tag' ? 'any'
      : (tagMatchMode || null),
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
    send_method: sendMethod || 'standard', // "standard" | "mm_lite"
    coupon_id: couponId || null,
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

  // CRIT-2B-10: enforce per-restaurant daily cap. Only gates fresh sends —
  // resumes of a previously counted campaign are allowed through so pausing
  // doesn't cost a second slot. Uses _cache bucket keyed by IST date so the
  // check is one lookup, not an aggregate over campaigns.
  if (!resuming) {
    const sentToday = await _getSentTodayCount(campaign.restaurant_id);
    const cap = await _getConfiguredCap(campaign.restaurant_id);
    if (cap > 0 && sentToday >= cap) {
      console.warn(`[CAMPAIGN] Daily cap reached for restaurant ${campaign.restaurant_id}`);
      await col('campaigns').updateOne({ _id: campaignId }, {
        $set: {
          status: 'capped',
          pause_reason: 'Daily campaign limit reached. Resumes tomorrow.',
          capped_at: new Date(),
        },
      });
      logActivity({
        actorType: 'system', action: 'campaign.capped', category: 'campaign',
        description: `Campaign ${campaignId} blocked by daily cap (${sentToday}/${cap})`,
        restaurantId: campaign.restaurant_id, resourceType: 'campaign', resourceId: campaignId,
        severity: 'warning', metadata: { sentToday, cap },
      });
      return { sent: 0, failed: 0, total: 0, capped: true, sent_today: sentToday, daily_cap: cap };
    }
    // Count the slot now so concurrent sends can't both pass the gate.
    await _bumpSentTodayCount(campaign.restaurant_id);
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

    // Route campaign sends through the restaurant-configured marketing
    // number when set (falls back to primary WABA number otherwise).
    const restaurant = await col('restaurants').findOne({ _id: campaign.restaurant_id });
    const outboundPid = wa.getOutboundNumberId({
      ...restaurant,
      phoneNumberId: waAccount.phone_number_id,
    });

    const customers = await getSegmentCustomers(campaign.restaurant_id, campaign.segment, {
      tags: campaign.tags,
      tagMatchMode: campaign.tag_match_mode,
    });
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
        log.info({ campaignId, pausedAtIndex: i }, 'Campaign paused by admin');
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
            outboundPid,
            waAccount.access_token,
            toId,
            catalogId,
            products,
            campaign
          );
          sent++;

          // Store message ID for delivery tracking + ROI attribution.
          // phone_hash + cost + sent_at populated so the analytics aggregate
          // doesn't have to join back to marketing_messages for every row,
          // and so order attribution can key on phone_hash directly.
          const msgId = result?.messages?.[0]?.id;
          if (msgId) {
            await col('campaign_messages').updateOne(
              { message_id: msgId },
              { $setOnInsert: {
                _id: newId(), message_id: msgId, campaign_id: campaignId,
                restaurant_id: campaign.restaurant_id,
                customer_id: String(customer._id),
                phone_hash: toId ? hashPhone(toId) : null,
                cost: MESSAGING_RATES.marketing,
                status: 'sent', sent_at: new Date(), created_at: new Date(),
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
          log.error({ campaignId, batch: batchNum, errorCode: errCode, errorMsg: err.response?.data?.error?.message || err.message }, 'Failed to send campaign message');
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

      logActivity({ actorType: 'system', action: 'campaign.batch_sent', category: 'campaign', description: `Campaign ${campaignId} batch ${batchNum}/${totalBatches} sent (${sent} sent, ${failed} failed)`, restaurantId: campaign.restaurant_id, resourceType: 'campaign', resourceId: campaignId, severity: 'info', metadata: { batch: batchNum, sent, failed } });

      // [WhatsApp2026] Health check: auto-pause if failure rate too high
      if (batchFailed > 0 && batch.length > 0) {
        const batchFailRate = (batchFailed / batch.length) * 100;
        if (batchFailRate > FAILURE_THRESHOLD_PCT) {
          log.warn({ campaignId, failRate: batchFailRate, batch: batchNum, failedPacing }, 'Campaign auto-paused due to high failure rate');
          await col('campaigns').updateOne({ _id: campaignId }, {
            $set: {
              status: 'paused',
              paused_at: new Date(),
              pause_reason: `Auto-paused: ${batchFailRate.toFixed(1)}% failure rate in batch ${batchNum}. ${failedPacing > 0 ? `Meta pacing errors: ${failedPacing}.` : ''} Review and resume when ready.`,
            },
          });
          logActivity({ actorType: 'system', action: 'campaign.paused', category: 'campaign', description: `Campaign ${campaignId} auto-paused: ${batchFailRate.toFixed(1)}% failure rate in batch ${batchNum}`, restaurantId: campaign.restaurant_id, resourceType: 'campaign', resourceId: campaignId, severity: 'warning', metadata: { failRate: batchFailRate, failedPacing, batch: batchNum } });
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

    logActivity({ actorType: 'system', action: 'campaign.completed', category: 'campaign', description: `Campaign ${campaignId} completed (${sent} sent, ${failed} failed)`, restaurantId: campaign.restaurant_id, resourceType: 'campaign', resourceId: campaignId, severity: 'info', metadata: { sent, failed, totalRecipients } });
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
    log.error({ err, campaignId }, 'Campaign resume failed');
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

// ─── MM LITE (Marketing Messages Lite API) ──────────────────────
// Meta's AI-optimized delivery for marketing templates.
// When enabled, adds messaging_product delivery hint to the send call.
// Currently applies to template messages; MPMs use standard delivery.
// Feature flag: platform_settings.mm_lite_enabled
async function isMMliteEnabled() {
  try {
    const setting = await col('platform_settings').findOne({ _id: 'mm_lite' });
    return !!setting?.enabled;
  } catch { return false; }
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
async function getSegmentCustomers(restaurantId, segment, options = {}) {
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
    case 'tag':
    case 'any_tag': {
      // Tag matching lives on customer_metrics (global by phone_hash). Scope to
      // restaurant via restaurant_stats.restaurant_id so we only message
      // customers who've actually ordered here. 'tag' = match ALL provided tags,
      // 'any_tag' = match ANY. We resolve back to customers rows to get
      // wa_phone/bsuid/name for the send.
      const tagList = Array.isArray(options.tags) ? options.tags : [];
      if (!tagList.length) return [];
      const tagOp = segment === 'any_tag' ? '$in' : '$all';
      const metricsDocs = await col('customer_metrics').find(
        {
          tags: { [tagOp]: tagList },
          'restaurant_stats.restaurant_id': restaurantId,
        },
        { projection: { phone_hash: 1 } },
      ).toArray();
      const hashes = metricsDocs.map(d => d.phone_hash).filter(Boolean);
      if (!hashes.length) return [];
      filter.phone_hash = { $in: hashes };
      break;
    }
    case 'all':
    default:
      break;
  }

  return col('customers').find(filter).project({ wa_phone: 1, bsuid: 1, name: 1 }).toArray();
}

// ─── LIST TAGS (for campaign targeting UI) ──────────────────────
// Returns distinct tags on customer_metrics docs that have at least one
// restaurant_stats entry for this restaurant. Powers the dashboard tag picker.
async function getAvailableTags(restaurantId) {
  const tags = await col('customer_metrics').distinct('tags', {
    'restaurant_stats.restaurant_id': restaurantId,
  });
  return (tags || []).filter(Boolean).sort();
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

// ─── DELETE CAMPAIGN (with cascade) ─────────────────────────────
async function deleteCampaign(campaignId, restaurantId) {
  const campaign = await col('campaigns').findOne({ _id: campaignId });
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.restaurant_id !== restaurantId) throw new Error('Not your campaign');
  if (campaign.status === 'sending') throw new Error('Cannot delete while sending');

  // Cascade: remove message tracking records
  await col('campaign_messages').deleteMany({ campaign_id: campaignId }).catch(() => {});

  // Unlink any coupons tied to this campaign (don't delete — just unlink)
  await col('coupons').updateMany(
    { campaign_id: campaignId },
    { $set: { campaign_id: null, updated_at: new Date() } }
  ).catch(() => {});

  await col('campaigns').deleteOne({ _id: campaignId });
  log.info({ campaignId }, 'Campaign deleted with cascade cleanup');
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
  isMMliteEnabled,
  getAvailableTags,
  getDailyUsage,
};
