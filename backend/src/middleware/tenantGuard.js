// src/middleware/tenantGuard.js
// Phase 1: request-time tenancy resolution for the customer-facing API.
//
// Two layers:
//
//   requireTenant    — resolves :restaurant_id (path or header) against
//                      the restaurants collection; attaches req.tenant.
//                      Rejects unknown / suspended tenants with 404.
//
//   requireCustomer  — resolves the caller's customer identity from a
//                      phone in the X-Customer-Phone header (MVP) or
//                      from a customer_id passed by an upstream auth
//                      layer if one exists. Attaches req.customer.
//
// These are intentionally NOT auth — the customer layer for WhatsApp
// ordering is identified by the phone Meta forwards us on inbound
// webhook events. A later auth hardening step can wrap these with
// signed tokens without changing the service surface.

'use strict';

const { col } = require('../config/database');
const customerSvc = require('../services/customer.service');

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

async function requireCustomer(req, res, next) {
  try {
    const phone = req.headers['x-customer-phone'] || req.body?.customer_phone || req.query?.customer_phone;
    const passedId = req.headers['x-customer-id'] || req.body?.customer_id;

    let customer = null;
    if (passedId) {
      customer = await customerSvc.findById(passedId);
    } else if (phone) {
      customer = await customerSvc.findOrCreateByPhone(phone);
    }
    if (!customer) {
      return res.status(401).json({ error: 'customer identity required (X-Customer-Phone)' });
    }
    req.customer = { id: String(customer._id), wa_phone: customer.wa_phone, name: customer.name || null };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireTenant, requireCustomer };
