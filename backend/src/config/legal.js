// src/config/legal.js
// Server-side mirror of frontend/src/lib/constants/legal.ts.
//
// These are the CURRENT published versions of the public legal
// documents (/terms, /privacy). The signup handler validates the
// client-submitted terms_version / privacy_version against these
// values and rejects the request if they do not match — this guards
// against a stale browser tab recording consent to an outdated
// document. Keep this file and the frontend constants in lock-step
// whenever the legal documents are revised.

'use strict';

const TERMS_VERSION = '2026-05-18';
const PRIVACY_VERSION = '2026-05-18';
const LEGAL_LAST_UPDATED = '18 May 2026';

module.exports = {
  TERMS_VERSION,
  PRIVACY_VERSION,
  LEGAL_LAST_UPDATED,
};
