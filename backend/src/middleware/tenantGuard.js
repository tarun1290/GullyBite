// src/middleware/tenantGuard.js
// Phase 1: request-time tenancy resolution for the customer-facing API.
//
// Two layers:
//
//   requireTenant    — resolves :restaurant_id (path or header) against
//                      the restaurants collection; attaches req.tenant.
//                      Rejects unknown / suspended tenants with 404.
//
//   requireCustomer  — DELEGATED to middleware/customerAuth.js. Verifies
//                      a signed customer JWT (or a service-secret bypass
//                      for trusted internal callers). The previous
//                      X-Customer-Phone header trust was OWASP A01 —
//                      anyone could read any customer's data by setting
//                      a header.

'use strict';

const { col } = require('../config/database');
const { requireCustomerAuth } = require('./customerAuth');

function _pickRestaurantId(req) {
  return (
    req.params?.restaurant_id ||
    req.headers['x-restaurant-id'] ||
    req.query?.restaurant_id ||
    null
  );
}

async function requireTenant(req, res, next) {
  try {
    const id = _pickRestaurantId(req);
    if (!id) return res.status(400).json({ error: 'restaurant_id is required' });

    const biz = await col('restaurants').findOne(
      { _id: String(id) },
      { projection: { status: 1, business_name: 1, business_type: 1 } }
    );
    if (!biz) return res.status(404).json({ error: 'restaurant not found' });
    if (biz.status && ['suspended', 'rejected'].includes(biz.status)) {
      return res.status(403).json({ error: 'restaurant is not active' });
    }

    req.tenant = { id: String(biz._id), name: biz.business_name, type: biz.business_type || 'single' };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireTenant, requireCustomer: requireCustomerAuth };
