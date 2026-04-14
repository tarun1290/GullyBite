// src/services/brandAnalytics.js
// Per-brand order analytics — one aggregation pipeline, optionally
// narrowed to a single brand. Runs against the canonical `orders`
// collection; business scope is resolved via `restaurant_id`, which
// is the business id in this codebase (restaurants._id). The
// optional `brand_id` field on `orders` was added in the brand-layer
// schema step, so rows pre-dating that migration group under
// `brand_id: null`.
//
// Returns:
//   {
//     total_orders, total_revenue, avg_order_value,
//     by_brand: [{ brand_id, orders, revenue, avg_order_value }, ...]
//   }

'use strict';

const { col } = require('../config/database');

function buildPipeline({ businessId, brandId = null } = {}) {
  if (!businessId) throw new Error('businessId is required');

  const match = { restaurant_id: String(businessId) };
  if (brandId) match.brand_id = String(brandId);

  return [
    // 1. Narrow to this business (and optionally this brand).
    { $match: match },

    // 2. Group by brand_id. Revenue uses `total_rs` (rupee float on
    //    orders). `$ifNull` collapses legacy rows without brand_id
    //    into a single bucket keyed `null` so they're still counted.
    {
      $group: {
        _id:     { $ifNull: ['$brand_id', null] },
        orders:  { $sum: 1 },
        revenue: { $sum: { $ifNull: ['$total_rs', 0] } },
      },
    },

    // 3. Shape per-brand rows.
    {
      $project: {
        _id: 0,
        brand_id: '$_id',
        orders:   1,
        revenue:  { $round: ['$revenue', 2] },
        avg_order_value: {
          $round: [
            { $cond: [{ $gt: ['$orders', 0] }, { $divide: ['$revenue', '$orders'] }, 0] },
            2,
          ],
        },
      },
    },

    // 4. Stable ordering — highest revenue first.
    { $sort: { revenue: -1 } },
  ];
}

async function getBrandAnalytics({ businessId, brandId = null } = {}) {
  const pipeline = buildPipeline({ businessId, brandId });
  const byBrand = await col('orders').aggregate(pipeline).toArray();

  const totalOrders  = byBrand.reduce((acc, r) => acc + (r.orders || 0), 0);
  const totalRevenue = byBrand.reduce((acc, r) => acc + (r.revenue || 0), 0);
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  return {
    total_orders:     totalOrders,
    total_revenue:    Math.round(totalRevenue * 100) / 100,
    avg_order_value:  Math.round(avgOrderValue * 100) / 100,
    by_brand:         byBrand,
  };
}

module.exports = { buildPipeline, getBrandAnalytics };
