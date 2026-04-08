// src/utils/logger.js
// Lightweight structured logger — zero dependencies.
//
// Usage:
//   const log = require('../utils/logger');
//   log.info('Server started');
//   log.info({ orderId, phone: '91xxxx' }, 'Order confirmed');
//   log.error({ err }, 'Payment failed');
//
// Child loggers carry context through a request:
//   const rlog = log.child({ requestId: req.id, restaurantId });
//   rlog.info('Loading menu');          // → includes requestId in every line
//
// Environment:
//   LOG_LEVEL  — debug | info | warn | error  (default: info in prod, debug in dev)
//   NODE_ENV   — production → JSON output;  anything else → human-readable

'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = { 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR' };

const isProd = process.env.NODE_ENV === 'production';
const minLevel = LEVELS[process.env.LOG_LEVEL] || (isProd ? LEVELS.info : LEVELS.debug);

// ── Sensitive field redaction ────────────────────────────────
const REDACT_KEYS = new Set([
  'password', 'secret', 'token', 'access_token', 'refresh_token',
  'authorization', 'cookie', 'jwt', 'api_key', 'apiKey',
  'razorpay_webhook_secret', 'webhook_secret',
]);

function redactValue(key, val) {
  if (typeof val !== 'string') return val;
  const k = key.toLowerCase();
  if (REDACT_KEYS.has(k)) return '[REDACTED]';
  // Mask phone numbers (10+ digits) in values — keep last 4
  if (/phone/i.test(k) && /^\+?\d{10,}$/.test(val)) {
    return val.slice(0, -4).replace(/\d/g, '*') + val.slice(-4);
  }
  return val;
}

function redactObj(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj instanceof Error) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

// ── Formatters ──────────────────────────────────────────────

function formatJson(level, ctx, msg) {
  const entry = {
    level: LEVEL_NAMES[level].toLowerCase(),
    ts: new Date().toISOString(),
    msg,
    ...redactObj(ctx),
  };
  // Attach error stack if present
  if (ctx.err instanceof Error) {
    entry.err = { message: ctx.err.message, stack: ctx.err.stack };
  }
  return JSON.stringify(entry);
}

function formatPretty(level, ctx, msg) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const lvl = LEVEL_NAMES[level].padEnd(5);
  const tag = ctx.component ? `[${ctx.component}] ` : '';

  // Build context suffix — skip component (already in tag) and err (shown separately)
  const pairs = [];
  const safeCtx = redactObj(ctx);
  for (const [k, v] of Object.entries(safeCtx)) {
    if (k === 'component' || k === 'err') continue;
    pairs.push(`${k}=${v}`);
  }
  const suffix = pairs.length ? ' ' + pairs.join(' ') : '';

  let line = `${ts} ${lvl} ${tag}${msg}${suffix}`;

  if (ctx.err instanceof Error) {
    line += `\n  ${ctx.err.stack || ctx.err.message}`;
  }

  return line;
}

const format = isProd ? formatJson : formatPretty;

// ── Logger class ────────────────────────────────────────────

class Logger {
  constructor(baseCtx = {}) {
    this._ctx = baseCtx;
  }

  child(extra) {
    return new Logger({ ...this._ctx, ...extra });
  }

  _write(level, args) {
    if (level < minLevel) return;

    // Parse args: optional context object, then message string
    let ctx = { ...this._ctx };
    let msg = '';

    if (args.length === 0) return;

    if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
      Object.assign(ctx, args[0]);
      msg = args.slice(1).join(' ');
    } else if (args[0] instanceof Error) {
      ctx.err = args[0];
      msg = args.slice(1).join(' ') || args[0].message;
    } else {
      msg = args.join(' ');
    }

    const output = format(level, ctx, msg);

    if (level >= LEVELS.error) {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }

  debug(...args) { this._write(LEVELS.debug, args); }
  info(...args)  { this._write(LEVELS.info, args); }
  warn(...args)  { this._write(LEVELS.warn, args); }
  error(...args) { this._write(LEVELS.error, args); }
}

module.exports = new Logger();
