// Owner daily summary cron — fires the same code path that the HTTP
// route GET /cron/owner-daily-summary triggers. Lives here so the EC2
// process self-schedules the daily fan-out without depending on an
// external cron service hitting the route.
//
// Schedule: 17:30 UTC daily = 23:00 IST = end of the IST business day,
// which is when the owner sees a meaningful "Today: N orders · ₹X"
// summary. Timezone is pinned to UTC because the route handler reads
// `todayStart = setHours(0,0,0,0)` against the server-local clock — on
// EC2 (UTC) that's UTC midnight, and the cron firing time matches.

'use strict';

const cron = require('node-cron');
const { runOwnerDailySummary } = require('../routes/cron');
const log = require('../utils/logger').child({ component: 'ownerDailySummary' });

const scheduleOwnerDailySummary = () => {
  log.info('[CRON] owner-daily-summary scheduled: daily at 17:30 UTC');
  cron.schedule(
    '30 17 * * *',
    async () => {
      try {
        await runOwnerDailySummary();
      } catch (err) {
        log.error({ err: err?.message }, '[CRON] owner-daily-summary failed');
      }
    },
    { timezone: 'UTC' },
  );
};

module.exports = { scheduleOwnerDailySummary };
