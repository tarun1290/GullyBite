// src/jobs/marketing-campaign-sender.js
// Picks up scheduled manual-blast campaigns (status=scheduled, send_at<=now)
// and fires services/marketingCampaigns.sendCampaign for each due row.
// Runs every minute IST; matches the legacy campaign-sender cadence but
// operates on the `marketing_campaigns` collection exclusively.

'use strict';

const cron = require('node-cron');
const { col } = require('../config/database');
const marketingCampaigns = require('../services/marketingCampaigns');
const log = require('../utils/logger').child({ component: 'marketing-campaign-sender' });

const JOB_NAME = 'marketingCampaignSender';

async function run() {
  try {
    const due = await col('marketing_campaigns').find({
      status: 'scheduled',
      send_at: { $lte: new Date() },
    }).toArray();
    if (!due.length) return;

    log.info({ count: due.length }, 'marketing campaigns due — sending now');
    for (const c of due) {
      try {
        await marketingCampaigns.sendCampaign(c._id);
      } catch (err) {
        log.error({ err, campaignId: c._id }, 'marketing campaign send failed');
      }
    }
  } catch (err) {
    log.error({ err }, 'marketing campaign cron tick failed');
  }
}

function schedule() {
  const expr = process.env.MARKETING_CAMPAIGN_CRON || '* * * * *';
  cron.schedule(expr, () => {
    run().catch((err) => log.error({ err }, 'marketing-campaign-sender crashed'));
  }, { timezone: 'Asia/Kolkata' });
  log.info({ expr }, 'marketing campaign sender scheduled');
}

module.exports = { run, schedule, JOB_NAME };
