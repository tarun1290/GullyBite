// src/utils/referralWindow.js
// Referral attribution window calculation.
// Rule: 4 hours if sent before 10 PM IST, 8 hours if sent at/after 10 PM IST.
// Anchor: the exact referral link send timestamp.

'use strict';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +5:30 from UTC
const LATE_NIGHT_HOUR = 22; // 10 PM IST

/**
 * Calculate the attribution window hours based on the referral send time.
 * @param {Date} sentAt - The exact time the referral link was sent/created
 * @returns {{ windowHours: number, expiresAt: Date, isLateNight: boolean }}
 */
function calculateAttributionWindow(sentAt) {
  const sendTime = sentAt instanceof Date ? sentAt : new Date(sentAt);

  // Convert to IST hour
  const istTime = new Date(sendTime.getTime() + IST_OFFSET_MS);
  const istHour = istTime.getUTCHours();

  // Late night rule: >= 10 PM IST → 8 hours; otherwise → 4 hours
  const isLateNight = istHour >= LATE_NIGHT_HOUR;
  const windowHours = isLateNight ? 8 : 4;

  const expiresAt = new Date(sendTime.getTime() + windowHours * 3600000);

  return { windowHours, expiresAt, isLateNight };
}

module.exports = { calculateAttributionWindow };
