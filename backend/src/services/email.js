'use strict';

// AWS SES email sender — single-purpose dispatch module. Modeled on
// services/expoPush.js: fire-and-forget, swallow errors with log.warn,
// never throw to callers. The backend has no other email path; this is
// the canonical surface for merchant communications (welcome, billing
// invoice, etc.).
//
// Configuration (env):
//   AWS_SES_REGION       — defaults to ap-south-1 if unset
//   AWS_ACCESS_KEY_ID    — shared with the S3 stack (already in env)
//   AWS_SECRET_ACCESS_KEY — shared with the S3 stack (already in env)
//   SES_FROM_EMAIL       — RFC-5322 sender ("Display Name <addr@dom>")
//
// Behavior on missing config: if SES_FROM_EMAIL is unset the send is
// skipped silently (log.warn once). If AWS creds are missing the SDK's
// default credential chain runs (EC2 instance role in prod). Lazy-init
// of SESClient so module load is cheap on cold boot.

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const log = require('../utils/logger').child({ component: 'email' });

let _ses = null;
function _getSes() {
  if (_ses) return _ses;
  _ses = new SESClient({
    region: process.env.AWS_SES_REGION || 'ap-south-1',
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
  });
  return _ses;
}

function _htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _fmtRs(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function _fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch {
    return '—';
  }
}

// Internal send primitive. Returns true on success, false on any
// failure (config missing, SES rejection, network blip). Never throws.
async function _send({ to, subject, html }) {
  const from = process.env.SES_FROM_EMAIL;
  if (!from) {
    log.warn('SES_FROM_EMAIL not set — skipping email send');
    return false;
  }
  if (!to || typeof to !== 'string' || !to.includes('@')) {
    log.warn({ to }, 'email skipped — invalid recipient');
    return false;
  }
  try {
    await _getSes().send(new SendEmailCommand({
      Source: from,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Html: { Data: html, Charset: 'UTF-8' } },
      },
    }));
    return true;
  } catch (err) {
    log.warn({ err: err && err.message, to, subject }, 'SES send failed');
    return false;
  }
}

// ─── 1. WELCOME EMAIL ─────────────────────────────────────────
// Sent once at signup. Greenfield surface — no prior welcome
// communication existed (signup currently emits only an admin-room
// socket event). Fire-and-forget from the signup route.
async function sendWelcomeEmail(restaurant) {
  try {
    const to = restaurant?.email;
    if (!to) return false;
    const businessName = _htmlEscape(restaurant?.business_name || restaurant?.brand_name || 'there');
    const ownerName = _htmlEscape(restaurant?.owner_name || 'there');
    const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:24px auto;color:#0f172a;line-height:1.5">
  <h2 style="margin:0 0 12px">Welcome to GullyBite 🎉</h2>
  <p>Hi ${ownerName},</p>
  <p>Your GullyBite dashboard for <strong>${businessName}</strong> is ready.</p>
  <p>Sign in to set up your menu, connect your WhatsApp Business number, and start taking orders.</p>
  <p>If you hit anything, reply to this email or message us at <a href="mailto:support@gullybite.com">support@gullybite.com</a>.</p>
  <p style="color:#64748b;font-size:12px;margin-top:24px">— The GullyBite team</p>
</body></html>`;
    return _send({ to, subject: 'Welcome to GullyBite 🎉', html });
  } catch (err) {
    log.warn({ err: err && err.message }, 'sendWelcomeEmail crashed');
    return false;
  }
}

// ─── 2. BILLING INVOICE / RECEIPT ─────────────────────────────
// Sent after each successful branch_subscription debit in
// jobs/settlement.js::deductBranchSubscriptions. Greenfield — prior
// to this module the merchant got no proactive billing notification on
// the success path (auto-pause failure path already fires an Expo
// push). Tax note is intentionally generic until the invoice format
// is approved by finance; this is a receipt, not a tax invoice.
async function sendBillingInvoiceEmail(restaurant, branch, deductionRs, paidThroughDate) {
  try {
    const to = restaurant?.email;
    if (!to) return false;
    const businessName = _htmlEscape(restaurant?.business_name || restaurant?.brand_name || '');
    const branchName = _htmlEscape(branch?.name || branch?._id || 'branch');
    const amountStr = _fmtRs(deductionRs);
    const paidThroughStr = _fmtDate(paidThroughDate);
    const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:24px auto;color:#0f172a;line-height:1.5">
  <h2 style="margin:0 0 12px">GullyBite — Subscription Invoice</h2>
  <p>Hi${businessName ? ` ${businessName} team` : ''},</p>
  <p>We've successfully deducted your branch subscription from your GullyBite wallet.</p>
  <table style="border-collapse:collapse;margin:16px 0;font-size:14px">
    <tr><td style="padding:6px 12px 6px 0;color:#64748b">Branch</td><td style="padding:6px 0"><strong>${branchName}</strong></td></tr>
    <tr><td style="padding:6px 12px 6px 0;color:#64748b">Amount</td><td style="padding:6px 0"><strong>${amountStr}</strong></td></tr>
    <tr><td style="padding:6px 12px 6px 0;color:#64748b">Next due</td><td style="padding:6px 0"><strong>${paidThroughStr}</strong></td></tr>
  </table>
  <p style="color:#64748b;font-size:12px">Amount is inclusive of applicable GST. A formal tax invoice is available from the dashboard's billing page.</p>
  <p style="color:#64748b;font-size:12px;margin-top:24px">— GullyBite Billing</p>
</body></html>`;
    return _send({ to, subject: 'GullyBite — Subscription Invoice', html });
  } catch (err) {
    log.warn({ err: err && err.message }, 'sendBillingInvoiceEmail crashed');
    return false;
  }
}

module.exports = { sendWelcomeEmail, sendBillingInvoiceEmail };
