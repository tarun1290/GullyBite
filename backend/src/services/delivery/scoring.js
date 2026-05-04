// src/services/delivery/scoring.js
// Quote-selection rules for the multi-3PL dispatcher. Pure function —
// no DB, no provider calls — so it's trivial to test against synthetic
// quote arrays. Add new rules here (e.g., reliability score, surge
// penalty, restaurant preference) without touching dispatcher.js.

'use strict';

// Distance threshold (km) above which "fastest" beats "cheapest".
// Short trips: customers care about price; long trips: ETA dominates
// because a slow rider on a 5+ km hop visibly hurts the food (cold
// arrival, customer-side complaints).
const DISTANCE_THRESHOLD_KM = 3;

/**
 * Pick the best delivery quote for the given distance.
 *
 * Selection rule:
 *   distanceKm  <  3 km → lowest deliveryFeeRs (cheapest)
 *   distanceKm  >= 3 km → lowest estimatedMins (fastest)
 *
 * Tie-break: the FIRST quote in the input array wins. Callers should
 * therefore order the array by their preferred fallback (typically
 * Object.entries(PROVIDERS) order — Prorouting first today).
 *
 * Edge cases:
 *   - empty / non-array → null
 *   - single quote → that quote (no comparison needed)
 *
 * @param {Array<{providerName, deliveryFeeRs, estimatedMins, distanceKm}>} quotes
 * @param {number} distanceKm
 * @returns {object|null}
 */
function pickProvider(quotes, distanceKm) {
  if (!Array.isArray(quotes) || quotes.length === 0) return null;
  if (quotes.length === 1) return quotes[0];

  const fastestWins = Number(distanceKm) >= DISTANCE_THRESHOLD_KM;
  const scoreField = fastestWins ? 'estimatedMins' : 'deliveryFeeRs';

  // Linear scan with explicit `<` (strict) so equal scores keep the
  // earlier candidate — that's the documented tie-break behaviour.
  let best = quotes[0];
  let bestScore = Number(best[scoreField]);
  if (!Number.isFinite(bestScore)) bestScore = Infinity;

  for (let i = 1; i < quotes.length; i++) {
    const cand = quotes[i];
    let candScore = Number(cand[scoreField]);
    if (!Number.isFinite(candScore)) candScore = Infinity;
    if (candScore < bestScore) {
      best = cand;
      bestScore = candScore;
    }
  }
  return best;
}

module.exports = {
  pickProvider,
  DISTANCE_THRESHOLD_KM,
};
