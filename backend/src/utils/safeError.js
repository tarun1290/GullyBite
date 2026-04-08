// src/utils/safeError.js
// Safe error response utility — prevents leaking internal error details to API consumers.
// Usage: res.status(500).json(safeError(e)) instead of res.status(500).json({ error: e.message })
//
// In production, returns a generic message. In development, includes the real error.
// Specific known errors (validation, not-found) are passed through safely.

'use strict';

const log = require('./logger').child({ component: 'safeError' });

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Create a safe error response object.
 * @param {Error|string} err - The error
 * @param {string} fallbackMsg - Client-facing message if real error is hidden
 * @returns {{ error: string }}
 */
function safeError(err, fallbackMsg = 'An unexpected error occurred. Please try again.') {
  const message = typeof err === 'string' ? err : err?.message || '';

  // Known safe errors — pass through
  if (message.includes('required') || message.includes('not found') || message.includes('Invalid') ||
      message.includes('already exists') || message.includes('not configured') || message.includes('not connected')) {
    return { error: message };
  }

  // In production, hide internal details
  if (IS_PROD) {
    // Log the real error server-side
    if (err?.stack) log.error({ err }, 'Hidden error in production response');
    return { error: fallbackMsg };
  }

  // In dev, include real error for debugging
  return { error: message };
}

module.exports = { safeError };
