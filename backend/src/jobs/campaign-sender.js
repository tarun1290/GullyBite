// src/jobs/campaign-sender.js
// Cron job: checks for scheduled campaigns and sends them when due

'use strict';

const cron = require('node-cron');
const campaignSvc = require('../services/campaigns');
const log = require('../utils/logger').child({ component: 'campaign' });

const scheduleCampaignSender = () => {
  // Check every minute for due campaigns
  cron.schedule('* * * * *', runCampaignCheck, { timezone: 'Asia/Kolkata' });
  log.info('campaign sender cron scheduled: every minute');
};

async function runCampaignCheck() {
  try {
    const due = await campaignSvc.getDueCampaigns();
    if (!due.length) return;

    log.info({ count: due.length }, 'scheduled campaigns due — sending now');
    for (const campaign of due) {
      try {
        const result = await campaignSvc.sendCampaign(campaign._id);
        log.info({ campaign: campaign.name, sent: result.sent, failed: result.failed }, 'campaign sent');
      } catch (err) {
        log.error({ err, campaign: campaign.name }, 'campaign send failed');
      }
    }
  } catch (err) {
    log.error({ err }, 'cron check error');
  }
}

module.exports = { scheduleCampaignSender };
