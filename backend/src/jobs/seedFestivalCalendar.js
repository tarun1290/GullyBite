// src/jobs/seedFestivalCalendar.js
// Idempotent seed for `festivals_calendar`. Inserts rows for the
// current year and next year if their slug is not already present.
// Called on every server boot (safe due to slug uniqueness + check-
// before-insert) and exposed as POST /api/admin/festivals/seed.

'use strict';

const { col, newId } = require('../config/database');
const log = require('../utils/logger').child({ component: 'seedFestivalCalendar' });

const JOB_NAME = 'seedFestivalCalendar';

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

// Festival definitions per year. Dates are midnight IST. Lunar
// festivals (Diwali, Eid, Navratri, Holi, Onam, etc.) were looked up
// for each year — admin can adjust via the admin panel if needed.
const FESTIVALS_BY_YEAR = {
  2025: [
    { slug: 'new_years_day_2025',      name: "New Year's Day",   date: '2025-01-01', hint: 'Wish your customers a happy new year and offer a fresh-start discount', applicable_to: 'all' },
    { slug: 'lohri_2025',              name: 'Lohri',            date: '2025-01-13', hint: 'Celebrate Lohri with a warm Punjabi feast offer',           applicable_to: 'sikh' },
    { slug: 'makar_sankranti_2025',    name: 'Makar Sankranti',  date: '2025-01-14', hint: 'Run a Pongal / Sankranti festive menu campaign',           applicable_to: 'hindu' },
    { slug: 'republic_day_2025',       name: 'Republic Day',     date: '2025-01-26', hint: 'Honour Republic Day with a tricolour special or patriotic combo', applicable_to: 'all' },
    { slug: 'valentines_day_2025',     name: "Valentine's Day",  date: '2025-02-14', hint: "Promote a couples' meal-for-two or dessert combo",          applicable_to: 'all' },
    { slug: 'holi_2025',               name: 'Holi',             date: '2025-03-14', hint: 'Send a Holi thali or gujiya special offer',                 applicable_to: 'hindu' },
    { slug: 'eid_ul_fitr_2025',        name: 'Eid ul-Fitr',      date: '2025-03-31', hint: 'Wish customers Eid Mubarak and feature an iftar / biryani platter', applicable_to: 'muslim' },
    { slug: 'ipl_start_2025',          name: 'IPL Season Start', date: '2025-03-22', hint: 'Launch a match-day snack combo for IPL openers',            applicable_to: 'all' },
    { slug: 'baisakhi_2025',           name: 'Baisakhi',         date: '2025-04-13', hint: 'Wish a happy Baisakhi with a Punjabi festive meal',         applicable_to: 'sikh' },
    { slug: 'mothers_day_2025',        name: "Mother's Day",     date: '2025-05-11', hint: 'Run a free-dessert-for-mom promo',                          applicable_to: 'all' },
    { slug: 'eid_ul_adha_2025',        name: 'Eid ul-Adha',      date: '2025-06-07', hint: 'Celebrate Bakrid with a family feast offer',                applicable_to: 'muslim' },
    { slug: 'fathers_day_2025',        name: "Father's Day",     date: '2025-06-15', hint: "Offer a dads-eat-free combo",                                applicable_to: 'all' },
    { slug: 'independence_day_2025',   name: 'Independence Day', date: '2025-08-15', hint: 'Celebrate Independence Day with a tricolour menu special',  applicable_to: 'all' },
    { slug: 'raksha_bandhan_2025',     name: 'Raksha Bandhan',   date: '2025-08-09', hint: 'Brother-sister meal combo for Raksha Bandhan',              applicable_to: 'hindu' },
    { slug: 'onam_2025',               name: 'Onam',             date: '2025-09-05', hint: 'Promote an Onam Sadhya platter',                            applicable_to: 'hindu' },
    { slug: 'ganesh_chaturthi_2025',   name: 'Ganesh Chaturthi', date: '2025-08-27', hint: 'Ganpati modak / festive thali promotion',                   applicable_to: 'hindu' },
    { slug: 'navratri_2025',           name: 'Navratri',         date: '2025-09-22', hint: 'Run a Navratri-vrat-friendly menu campaign',                applicable_to: 'hindu' },
    { slug: 'durga_puja_2025',         name: 'Durga Puja',       date: '2025-10-01', hint: 'Durga Puja Bengali festive specials',                       applicable_to: 'hindu' },
    { slug: 'diwali_2025',             name: 'Diwali',           date: '2025-10-21', hint: 'Wish customers Happy Diwali with a festive mithai / thali combo', applicable_to: 'hindu' },
    { slug: 'christmas_2025',          name: 'Christmas',        date: '2025-12-25', hint: 'Send a Christmas-eve family feast offer',                   applicable_to: 'christian' },
    { slug: 'new_years_eve_2025',      name: "New Year's Eve",   date: '2025-12-31', hint: 'Promote a party menu for the NYE crowd',                    applicable_to: 'all' },
  ],
  2026: [
    { slug: 'new_years_day_2026',      name: "New Year's Day",   date: '2026-01-01', hint: 'Wish your customers a happy new year and offer a fresh-start discount', applicable_to: 'all' },
    { slug: 'lohri_2026',              name: 'Lohri',            date: '2026-01-13', hint: 'Celebrate Lohri with a warm Punjabi feast offer',           applicable_to: 'sikh' },
    { slug: 'makar_sankranti_2026',    name: 'Makar Sankranti',  date: '2026-01-14', hint: 'Run a Pongal / Sankranti festive menu campaign',           applicable_to: 'hindu' },
    { slug: 'republic_day_2026',       name: 'Republic Day',     date: '2026-01-26', hint: 'Honour Republic Day with a tricolour special or patriotic combo', applicable_to: 'all' },
    { slug: 'valentines_day_2026',     name: "Valentine's Day",  date: '2026-02-14', hint: "Promote a couples' meal-for-two or dessert combo",          applicable_to: 'all' },
    { slug: 'holi_2026',               name: 'Holi',             date: '2026-03-03', hint: 'Send a Holi thali or gujiya special offer',                 applicable_to: 'hindu' },
    { slug: 'eid_ul_fitr_2026',        name: 'Eid ul-Fitr',      date: '2026-03-20', hint: 'Wish customers Eid Mubarak and feature an iftar / biryani platter', applicable_to: 'muslim' },
    { slug: 'ipl_start_2026',          name: 'IPL Season Start', date: '2026-03-25', hint: 'Launch a match-day snack combo for IPL openers',            applicable_to: 'all' },
    { slug: 'baisakhi_2026',           name: 'Baisakhi',         date: '2026-04-14', hint: 'Wish a happy Baisakhi with a Punjabi festive meal',         applicable_to: 'sikh' },
    { slug: 'mothers_day_2026',        name: "Mother's Day",     date: '2026-05-10', hint: 'Run a free-dessert-for-mom promo',                          applicable_to: 'all' },
    { slug: 'eid_ul_adha_2026',        name: 'Eid ul-Adha',      date: '2026-05-27', hint: 'Celebrate Bakrid with a family feast offer',                applicable_to: 'muslim' },
    { slug: 'fathers_day_2026',        name: "Father's Day",     date: '2026-06-21', hint: "Offer a dads-eat-free combo",                                applicable_to: 'all' },
    { slug: 'independence_day_2026',   name: 'Independence Day', date: '2026-08-15', hint: 'Celebrate Independence Day with a tricolour menu special',  applicable_to: 'all' },
    { slug: 'onam_2026',               name: 'Onam',             date: '2026-08-26', hint: 'Promote an Onam Sadhya platter',                            applicable_to: 'hindu' },
    { slug: 'raksha_bandhan_2026',     name: 'Raksha Bandhan',   date: '2026-08-28', hint: 'Brother-sister meal combo for Raksha Bandhan',              applicable_to: 'hindu' },
    { slug: 'ganesh_chaturthi_2026',   name: 'Ganesh Chaturthi', date: '2026-09-14', hint: 'Ganpati modak / festive thali promotion',                   applicable_to: 'hindu' },
    { slug: 'navratri_2026',           name: 'Navratri',         date: '2026-10-12', hint: 'Run a Navratri-vrat-friendly menu campaign',                applicable_to: 'hindu' },
    { slug: 'durga_puja_2026',         name: 'Durga Puja',       date: '2026-10-19', hint: 'Durga Puja Bengali festive specials',                       applicable_to: 'hindu' },
    { slug: 'diwali_2026',             name: 'Diwali',           date: '2026-11-08', hint: 'Wish customers Happy Diwali with a festive mithai / thali combo', applicable_to: 'hindu' },
    { slug: 'christmas_2026',          name: 'Christmas',        date: '2026-12-25', hint: 'Send a Christmas-eve family feast offer',                   applicable_to: 'christian' },
    { slug: 'new_years_eve_2026',      name: "New Year's Eve",   date: '2026-12-31', hint: 'Promote a party menu for the NYE crowd',                    applicable_to: 'all' },
  ],
  2027: [
    { slug: 'new_years_day_2027',      name: "New Year's Day",   date: '2027-01-01', hint: 'Wish your customers a happy new year and offer a fresh-start discount', applicable_to: 'all' },
    { slug: 'lohri_2027',              name: 'Lohri',            date: '2027-01-13', hint: 'Celebrate Lohri with a warm Punjabi feast offer',           applicable_to: 'sikh' },
    { slug: 'makar_sankranti_2027',    name: 'Makar Sankranti',  date: '2027-01-14', hint: 'Run a Pongal / Sankranti festive menu campaign',           applicable_to: 'hindu' },
    { slug: 'republic_day_2027',       name: 'Republic Day',     date: '2027-01-26', hint: 'Honour Republic Day with a tricolour special or patriotic combo', applicable_to: 'all' },
    { slug: 'valentines_day_2027',     name: "Valentine's Day",  date: '2027-02-14', hint: "Promote a couples' meal-for-two or dessert combo",          applicable_to: 'all' },
    { slug: 'eid_ul_fitr_2027',        name: 'Eid ul-Fitr',      date: '2027-03-10', hint: 'Wish customers Eid Mubarak and feature an iftar / biryani platter', applicable_to: 'muslim' },
    { slug: 'holi_2027',               name: 'Holi',             date: '2027-03-22', hint: 'Send a Holi thali or gujiya special offer',                 applicable_to: 'hindu' },
    { slug: 'ipl_start_2027',          name: 'IPL Season Start', date: '2027-03-26', hint: 'Launch a match-day snack combo for IPL openers',            applicable_to: 'all' },
    { slug: 'baisakhi_2027',           name: 'Baisakhi',         date: '2027-04-14', hint: 'Wish a happy Baisakhi with a Punjabi festive meal',         applicable_to: 'sikh' },
    { slug: 'mothers_day_2027',        name: "Mother's Day",     date: '2027-05-09', hint: 'Run a free-dessert-for-mom promo',                          applicable_to: 'all' },
    { slug: 'eid_ul_adha_2027',        name: 'Eid ul-Adha',      date: '2027-05-16', hint: 'Celebrate Bakrid with a family feast offer',                applicable_to: 'muslim' },
    { slug: 'fathers_day_2027',        name: "Father's Day",     date: '2027-06-20', hint: "Offer a dads-eat-free combo",                                applicable_to: 'all' },
    { slug: 'independence_day_2027',   name: 'Independence Day', date: '2027-08-15', hint: 'Celebrate Independence Day with a tricolour menu special',  applicable_to: 'all' },
    { slug: 'raksha_bandhan_2027',     name: 'Raksha Bandhan',   date: '2027-08-17', hint: 'Brother-sister meal combo for Raksha Bandhan',              applicable_to: 'hindu' },
    { slug: 'ganesh_chaturthi_2027',   name: 'Ganesh Chaturthi', date: '2027-09-04', hint: 'Ganpati modak / festive thali promotion',                   applicable_to: 'hindu' },
    { slug: 'onam_2027',               name: 'Onam',             date: '2027-09-14', hint: 'Promote an Onam Sadhya platter',                            applicable_to: 'hindu' },
    { slug: 'navratri_2027',           name: 'Navratri',         date: '2027-10-01', hint: 'Run a Navratri-vrat-friendly menu campaign',                applicable_to: 'hindu' },
    { slug: 'durga_puja_2027',         name: 'Durga Puja',       date: '2027-10-08', hint: 'Durga Puja Bengali festive specials',                       applicable_to: 'hindu' },
    { slug: 'diwali_2027',             name: 'Diwali',           date: '2027-10-28', hint: 'Wish customers Happy Diwali with a festive mithai / thali combo', applicable_to: 'hindu' },
    { slug: 'christmas_2027',          name: 'Christmas',        date: '2027-12-25', hint: 'Send a Christmas-eve family feast offer',                   applicable_to: 'christian' },
    { slug: 'new_years_eve_2027',      name: "New Year's Eve",   date: '2027-12-31', hint: 'Promote a party menu for the NYE crowd',                    applicable_to: 'all' },
  ],
};

// Build a Date representing midnight IST of the given YYYY-MM-DD. IST
// is UTC+05:30, so midnight IST = 18:30 UTC on the previous day.
function midnightIst(yyyyMmDd) {
  return new Date(`${yyyyMmDd}T00:00:00+05:30`);
}

async function seedYear(year) {
  const rows = FESTIVALS_BY_YEAR[year];
  if (!rows) return { inserted: 0, skipped: 0, year };

  const existingSlugs = new Set(
    (await col('festivals_calendar').find(
      { year },
      { projection: { slug: 1 } },
    ).toArray()).map((r) => r.slug),
  );

  let inserted = 0;
  let skipped = 0;
  const now = new Date();

  for (const f of rows) {
    if (existingSlugs.has(f.slug)) { skipped++; continue; }
    const festivalDate = midnightIst(f.date);
    const notificationDate = new Date(festivalDate.getTime() - FORTY_EIGHT_HOURS_MS);
    try {
      await col('festivals_calendar').insertOne({
        _id: newId(),
        name: f.name,
        slug: f.slug,
        date: festivalDate,
        notification_date: notificationDate,
        default_template_use_case: 'festival',
        suggested_message_hint: f.hint || null,
        applicable_to: f.applicable_to || 'all',
        is_active: true,
        year,
        created_at: now,
        updated_at: null,
      });
      inserted++;
    } catch (err) {
      // Unique index race — count as skipped.
      if (err && err.code === 11000) { skipped++; continue; }
      throw err;
    }
  }

  return { year, inserted, skipped };
}

async function run({ years } = {}) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const targets = Array.isArray(years) && years.length
    ? years
    : [currentYear, currentYear + 1];

  const results = [];
  for (const y of targets) {
    try {
      results.push(await seedYear(y));
    } catch (err) {
      log.error({ err, year: y }, 'festival seed year failed');
    }
  }

  const inserted = results.reduce((s, r) => s + (r.inserted || 0), 0);
  const skipped  = results.reduce((s, r) => s + (r.skipped  || 0), 0);
  log.info({ results, inserted, skipped }, 'festival calendar seed complete');
  return { results, inserted, skipped };
}

module.exports = { run, JOB_NAME, FESTIVALS_BY_YEAR };
