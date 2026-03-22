// src/jobs/campaign-sender.js
// Cron job: checks for scheduled campaigns and sends them when due

'use strict';

const cron = require('node-cron');
const campaignSvc = require('../services/campaigns');

const scheduleCampaignSender = () => {
  // Check every minute for due campaigns
  cron.schedule('* * * * *', runCampaignCheck, { timezone: 'Asia/Kolkata' });
  console.log('📢 Campaign sender cron scheduled: every minute');
};

async function runCampaignCheck() {
  try {
    const due = await campaignSvc.getDueCampaigns();
    if (!due.length) return;

    console.log(`[Campaigns] ${due.length} scheduled campaign(s) due — sending now`);
    for (const campaign of due) {
      try {
        const result = await campaignSvc.sendCampaign(campaign._id);
        console.log(`[Campaigns] "${campaign.name}" sent: ${result.sent} delivered, ${result.failed} failed`);
      } catch (err) {
        console.error(`[Campaigns] "${campaign.name}" send failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Campaigns] Cron check error:', err.message);
  }
}

module.exports = { scheduleCampaignSender };
