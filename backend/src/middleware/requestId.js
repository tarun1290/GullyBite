// src/middleware/requestId.js
// Assigns a unique request ID to every incoming request and creates a child logger.
//
// After this middleware:
//   req.id       — unique request ID (forwarded from X-Request-Id header or generated)
//   req.log      — child logger with { requestId, method, path } context
//
// Response includes X-Request-Id header for client-side correlation.

'use strict';

const crypto = require('crypto');
const log = require('../utils/logger');

function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', req.id);

  req.log = log.child({
    requestId: req.id,
    method: req.method,
    path: req.originalUrl?.split('?')[0],
  });

  next();
}

module.exports = requestId;
