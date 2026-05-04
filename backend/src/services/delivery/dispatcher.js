// src/services/delivery/dispatcher.js
// Multi-3PL dispatcher — fans out a quote request to every enabled
// provider in parallel, drops failures, and asks scoring.pickProvider
// to choose the best one. Returns both the chosen quote and the full
// list of estimates so the caller can persist an audit trail of what
// every partner offered (useful when ops asks "why did we go with X
// instead of Y?" weeks after the fact).
//
// Provider list comes from index.js's PROVIDERS map — adding a new
// 3PL there is enough; this file is generic.

'use strict';

const log = require('../../utils/logger').child({ component: 'DeliveryDispatcher' });
const { col } = require('../../config/database');
const { pickProvider } = require('./scoring');

/**
 * Get the best delivery quote across all enabled providers.
 *
 * @param {string} branchId
 * @param {number|string} deliveryLat
 * @param {number|string} deliveryLng
 * @param {object} orderDetails — { deliveryAddress, customerName, customerPhone, ... }
 * @returns {Promise<{ chosen: object, estimates: object[] }>}
 *   chosen — the selected quote object (with providerName)
 *   estimates — every successful quote, including losers (audit trail)
 * @throws if zero providers returned a successful quote
 */
async function getBestQuote(branchId, deliveryLat, deliveryLng, orderDetails = {}) {
  const branch = await col('branches').findOne({ _id: branchId });
  if (!branch) throw new Error('Branch not found');
  const restaurant = await col('restaurants').findOne({ _id: branch.restaurant_id });

  const pickup = {
    lat: parseFloat(branch.latitude),
    lng: parseFloat(branch.longitude),
    address: branch.address || '',
    contactName: branch.name,
    contactPhone: branch.manager_phone || restaurant?.phone || '',
  };
  const drop = {
    lat: parseFloat(deliveryLat),
    lng: parseFloat(deliveryLng),
    address: orderDetails.deliveryAddress || '',
    contactName: orderDetails.customerName || 'Customer',
    contactPhone: orderDetails.customerPhone || '',
  };

  // Lazy require breaks the circular dep with index.js (index requires
  // dispatcher → dispatcher requires index for PROVIDERS). At call
  // time, index.js's exports object is fully populated. Object.entries
  // walks the live map, so a future provider added to PROVIDERS in
  // index.js is picked up here automatically.
  const { PROVIDERS } = require('./index');
  const providerEntries = Object.entries(PROVIDERS || {});

  if (providerEntries.length === 0) {
    throw new Error('No delivery providers configured');
  }

  const settled = await Promise.allSettled(
    providerEntries.map(async ([name, provider]) => {
      const quote = await provider.getQuote(pickup, drop, orderDetails);
      // Defensive: backfill providerName from the map key if a
      // provider's getQuote forgot to set it. Downstream selection
      // and dispatch resolution both rely on this field.
      return { ...quote, providerName: quote.providerName || name };
    }),
  );

  const successful = [];
  settled.forEach((res, idx) => {
    const [name] = providerEntries[idx];
    if (res.status === 'fulfilled') {
      successful.push(res.value);
    } else {
      log.warn(
        { provider: name, err: res.reason?.message || String(res.reason) },
        'provider quote failed — excluded from selection',
      );
    }
  });

  if (successful.length === 0) {
    throw new Error('No delivery providers returned a quote');
  }

  // Use the first successful quote's distanceKm to drive the scoring
  // rule. All providers compute distance from the same coords, so
  // the value should be ~identical across them; if they diverge,
  // the first-quote distance is no worse than any other choice and
  // keeps the scoring deterministic.
  const distanceKm = Number(successful[0]?.distanceKm) || 0;
  const chosen = pickProvider(successful, distanceKm);

  log.info(
    {
      chosen: chosen?.providerName,
      candidates: successful.map((q) => ({
        provider: q.providerName,
        feeRs: q.deliveryFeeRs,
        mins: q.estimatedMins,
      })),
      distanceKm,
    },
    'best quote selected',
  );

  // Audit-trail shape per Phase 1 Part 3 spec: each estimate carries
  // an explicit `won: true|false` flag and a `timestamp`. We use the
  // boolean (not "match providerName to chosen.providerName at read
  // time") so audit-side consumers — dashboards, ad-hoc queries,
  // settlement reconciliation — can filter with a single field check
  // instead of joining each row against the chosen quote. Adds one
  // boolean per row; trivial cost vs. clearer downstream contract.
  const stampedAt = new Date();
  const estimates = successful.map((q) => ({
    providerName: q.providerName,
    deliveryFeeRs: q.deliveryFeeRs,
    estimatedMins: q.estimatedMins,
    distanceKm: q.distanceKm,
    quoteId: q.quoteId || null,
    timestamp: stampedAt,
    won: chosen ? q.providerName === chosen.providerName : false,
  }));

  return { chosen, estimates };
}

module.exports = { getBestQuote };
