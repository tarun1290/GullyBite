#!/usr/bin/env node
'use strict';

// scripts/diagnose-recent-adds.js
//
// Read-only diagnostic for "did yesterday's menu adds actually persist?"
// Looks at every menu_items doc created in the last WINDOW_HOURS for the
// target restaurant and answers:
//   • Did the expected number of items land in Mongo at all?
//   • Which branches got which items (incl. branches with zero adds, so
//     gaps are visible — left-join over the branches collection rather
//     than $group on items, which would silently hide empty branches).
//   • Field-shape distribution — branch_id scalar vs branch_ids array,
//     is_available, retailer_id, catalog_sync_status. Catches a silent
//     writer-path divergence where some items go via Menu Editor (scalar)
//     and others via the products API (array only).
//   • MPM-eligibility on the same set, against the exact mpmBuilder.js
//     filter. Plus the full doc of any item that fails the filter.
//   • The jubilee hills outlier — single doc where branch_ids contains
//     the jubilee branch but the scalar branch_id doesn't match it. Tells
//     us whether the gap surfaced by diagnose-branch-items.js is one of
//     yesterday's adds or older drift.
//
// Run on EC2:
//   cd /home/ubuntu/GullyBite/backend
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/diagnose-recent-adds.js
//
// No writes. Safe to run against prod.

const path = require('path');
const { connect, col } = require(path.join(__dirname, '..', 'src', 'config', 'database'));

const RESTAURANT_NAME_QUERY = 'beyond snacks';
const WINDOW_HOURS = 48;
const EXPECTED_RECENT_ADDS = 16;

function fmtDate(d) {
  if (!d) return '(none)';
  try { return new Date(d).toISOString(); } catch { return '(invalid)'; }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function header(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length - 4))}`);
}

// Duplicated from diagnose-branch-items.js intentionally — keeps this
// script's entry point self-contained per the spec ("do not import from
// diagnose-branch-items.js if it requires module refactoring"). _id first,
// then case-insensitive regex over the three name fields. Returns the
// single best match or null.
async function findRestaurant(query) {
  const byId = await col('restaurants').findOne({ _id: String(query) });
  if (byId) return byId;
  const re = new RegExp(escapeRegex(query), 'i');
  const matches = await col('restaurants')
    .find({
      $or: [
        { business_name: { $regex: re } },
        { brand_name:    { $regex: re } },
        { name:          { $regex: re } },
      ],
    })
    .project({ _id: 1, business_name: 1, brand_name: 1, name: 1 })
    .limit(1)
    .toArray();
  return matches[0] || null;
}

(async () => {
  let exitCode = 0;
  try {
    await connect();

    const restaurant = await findRestaurant(RESTAURANT_NAME_QUERY);
    if (!restaurant) {
      console.log(`No restaurant matched "${RESTAURANT_NAME_QUERY}". Aborting.`);
      process.exit(2);
    }
    const restaurantId = String(restaurant._id);
    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

    const rname = restaurant.business_name || restaurant.brand_name || restaurant.name || '(unnamed)';
    header(`RESTAURANT — ${rname} (${restaurantId})`);
    console.log(`  Window: created_at >= ${since.toISOString()} (last ${WINDOW_HOURS}h)`);
    console.log(`  Now (UTC): ${new Date().toISOString()}`);

    // Filters reused throughout. baseFilter is restaurant-scoped + window;
    // every section below either uses it directly or layers a per-branch
    // OR onto it.
    const baseFilter = {
      restaurant_id: restaurantId,
      created_at: { $gte: since },
    };

    // ── (a) TOTAL COUNT IN WINDOW ────────────────────────────────
    header('(a) TOTAL ITEMS CREATED IN WINDOW');
    const totalInWindow = await col('menu_items').countDocuments(baseFilter);
    console.log(`  Expected ~${EXPECTED_RECENT_ADDS}, found ${totalInWindow}.`);

    // ── (b) PER-BRANCH BREAKDOWN (left-join over branches) ───────
    // Spec calls out left-join semantics: every branch gets a row, even
    // ones with zero adds in the window — that's the whole point. A
    // $group on menu_items would silently drop empty branches.
    header('(b) PER-BRANCH BREAKDOWN (window only)');
    const branches = await col('branches')
      .find({ restaurant_id: restaurantId })
      .project({ _id: 1, name: 1, branch_slug: 1 })
      .toArray();
    branches.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    const branchRows = await Promise.all(branches.map(async (b) => {
      const id = String(b._id);
      // Match items that point at this branch via either field — diverging
      // writer paths are exactly what we're trying to catch, so we don't
      // restrict to the scalar field alone here.
      const filter = {
        $or: [{ branch_id: id }, { branch_ids: id }],
        created_at: { $gte: since },
        restaurant_id: restaurantId,
      };
      const count = await col('menu_items').countDocuments(filter);
      let sample = null;
      if (count > 0) {
        sample = await col('menu_items')
          .find(filter)
          .sort({ created_at: -1, _id: -1 })
          .project({ name: 1, created_at: 1 })
          .limit(1)
          .next();
      }
      return {
        branch_name: b.name || '(none)',
        branch_slug: b.branch_slug || '(none)',
        branch_id: id.slice(-8),
        items_created_in_window: count,
        sample_item_name: sample ? (sample.name || '(no name)') : '—',
        sample_created_at: sample ? fmtDate(sample.created_at) : '—',
      };
    }));
    console.table(branchRows);
    const nonZero = branchRows.filter((r) => r.items_created_in_window > 0).length;
    console.log(`  ${nonZero}/${branchRows.length} branches received an item in the window.`);
    if (nonZero < branchRows.length) {
      const empties = branchRows.filter((r) => r.items_created_in_window === 0)
        .map((r) => r.branch_name).join(', ');
      console.log(`  Branches with zero recent adds: ${empties}`);
    }

    // ── (c) FIELD-SHAPE DISTRIBUTION ─────────────────────────────
    header('(c) FIELD-SHAPE DISTRIBUTION (window only)');
    const [
      withScalarBranchId,
      missingScalarBranchId,
      withBranchIdsArrayNonEmpty,
      isAvailableTrue,
      isAvailableFalse,
      isAvailableMissing,
      retailerIdNonEmpty,
      retailerIdMissing,
    ] = await Promise.all([
      col('menu_items').countDocuments({ ...baseFilter, branch_id: { $exists: true, $nin: [null, ''] } }),
      // `{branch_id: null}` matches missing-or-null in Mongo; explicit `''`
      // covers the empty-string edge case some legacy paths produce.
      col('menu_items').countDocuments({ ...baseFilter, $or: [{ branch_id: null }, { branch_id: '' }] }),
      // `branch_ids.0: {$exists: true}` is the idiomatic "array has at
      // least one element" — avoids the $not/$size combo, which is
      // restricted in some Mongo versions.
      col('menu_items').countDocuments({ ...baseFilter, 'branch_ids.0': { $exists: true } }),
      col('menu_items').countDocuments({ ...baseFilter, is_available: true }),
      col('menu_items').countDocuments({ ...baseFilter, is_available: false }),
      col('menu_items').countDocuments({ ...baseFilter, is_available: { $exists: false } }),
      col('menu_items').countDocuments({ ...baseFilter, retailer_id: { $exists: true, $nin: [null, ''] } }),
      col('menu_items').countDocuments({ ...baseFilter, $or: [{ retailer_id: null }, { retailer_id: '' }] }),
    ]);
    console.log(`  branch_id (scalar) set         : ${withScalarBranchId}`);
    console.log(`  branch_id (scalar) null/missing: ${missingScalarBranchId}`);
    console.log(`  branch_ids (array) non-empty   : ${withBranchIdsArrayNonEmpty}`);
    console.log(`  is_available: true             : ${isAvailableTrue}`);
    console.log(`  is_available: false            : ${isAvailableFalse}`);
    console.log(`  is_available missing           : ${isAvailableMissing}`);
    console.log(`  retailer_id non-empty          : ${retailerIdNonEmpty}`);
    console.log(`  retailer_id null/missing       : ${retailerIdMissing}`);

    const statusDist = await col('menu_items').aggregate([
      { $match: baseFilter },
      { $group: { _id: '$catalog_sync_status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();
    console.log('  catalog_sync_status distribution:');
    if (!statusDist.length) {
      console.log('    (none)');
    } else {
      for (const s of statusDist) {
        const label = s._id == null ? '(missing/null)' : String(s._id);
        console.log(`    ${label.padEnd(20)} : ${s.count}`);
      }
    }

    // ── (d) MPM-ELIGIBILITY ──────────────────────────────────────
    // Filter mirrors services/mpmBuilder.js exactly. If this number ever
    // drifts from `withScalarBranchId ∩ isAvailable:true ∩ retailerIdNonEmpty`
    // a query above is wrong — they should match.
    header('(d) MPM-ELIGIBILITY OF RECENT ITEMS');
    const mpmEligible = await col('menu_items').countDocuments({
      ...baseFilter,
      branch_id: { $exists: true, $nin: [null, ''] },
      is_available: true,
      retailer_id: { $exists: true, $nin: [null, ''] },
    });
    console.log(`  MPM-eligible recent items: ${mpmEligible} of ${totalInWindow}.`);

    // ── (e) ITEMS FAILING MPM-ELIGIBILITY (cap 5, full doc) ──────
    header('(e) RECENT ITEMS FAILING MPM-ELIGIBILITY (up to 5, full doc)');
    const ineligibleFilter = {
      ...baseFilter,
      $or: [
        { branch_id: null },
        { branch_id: '' },
        { is_available: { $ne: true } },
        { retailer_id: null },
        { retailer_id: '' },
      ],
    };
    const ineligible = await col('menu_items')
      .find(ineligibleFilter)
      .sort({ created_at: -1, _id: -1 })
      .limit(5)
      .toArray();
    if (!ineligible.length) {
      console.log('  (none — every recent item satisfies the MPM filter)');
    } else {
      for (const it of ineligible) {
        console.log('  ── item ──');
        console.log(JSON.stringify(it, null, 2).split('\n').map((ln) => '  ' + ln).join('\n'));
        console.log('');
      }
    }

    // ── (f) JUBILEE HILLS OUTLIER ────────────────────────────────
    // The previous diagnostic flagged jubilee hills as the one branch with
    // a branch_ids/branch_id mismatch. Pull that exact doc and stamp it
    // against the window so we know whether the gap is yesterday's drift
    // or older.
    header('(f) JUBILEE HILLS OUTLIER');
    const jubilee = branches.find((b) =>
      String(b.branch_slug || '').toLowerCase() === 'jubilee-hills' ||
      String(b.name || '').toLowerCase().includes('jubilee')
    );
    if (!jubilee) {
      console.log('  (no jubilee hills branch found in this restaurant — skipping)');
    } else {
      const jId = String(jubilee._id);
      console.log(`  Jubilee branch _id: ${jId}`);
      // Items where branch_ids contains jubilee but the scalar branch_id
      // is missing/null OR points elsewhere. The query is restaurant- and
      // branch-scoped, so the result set is bounded.
      const outliers = await col('menu_items')
        .find({
          restaurant_id: restaurantId,
          branch_ids: jId,
          $or: [
            { branch_id: null },
            { branch_id: '' },
            { branch_id: { $ne: jId } },
          ],
        })
        .sort({ created_at: -1, _id: -1 })
        .limit(3)
        .toArray();
      if (!outliers.length) {
        console.log('  (no outlier item — branch_ids and branch_id are aligned for this branch)');
      } else {
        console.log(`  Found ${outliers.length} outlier item(s). Showing all:`);
        for (const o of outliers) {
          const inWindow = o.created_at && new Date(o.created_at) >= since;
          console.log('');
          console.log(`  Outlier created_at: ${fmtDate(o.created_at)}`);
          console.log(`  Within ${WINDOW_HOURS}h window? ${inWindow ? 'YES — likely one of the recent adds' : 'NO — older drift, unrelated to recent adds'}`);
          console.log('  ── item ──');
          console.log(JSON.stringify(o, null, 2).split('\n').map((ln) => '  ' + ln).join('\n'));
        }
      }
    }
  } catch (err) {
    console.error('[diag] ERROR:', err && err.message ? err.message : err);
    exitCode = 1;
  } finally {
    try { await globalThis._mongoClient?.close(); } catch (_) { /* ignore */ }
    process.exit(exitCode);
  }
})();
