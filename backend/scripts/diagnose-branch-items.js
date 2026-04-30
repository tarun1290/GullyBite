#!/usr/bin/env node
'use strict';

// scripts/diagnose-branch-items.js
//
// Read-only diagnostic for the "items in catalog but not in MPM" failure
// mode. Defaults to restaurant "beyond snacks" — override via
// `--restaurant=<name|id>`. With no positional arg, walks every branch of
// the restaurant and prints a summary table. With one positional arg
// (branch _id, slug, or a case-insensitive substring of the name) the
// script drills into that one branch only.
//
// Run on EC2:
//   cd /home/ubuntu/GullyBite/backend
//   # All branches:
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/diagnose-branch-items.js
//   # One branch (by _id, slug, or name substring):
//   node --env-file=/home/ubuntu/GullyBite/.env scripts/diagnose-branch-items.js kphb
//   # Override target restaurant:
//   node --env-file=/home/ubuntu/GullyBite/.env \
//        scripts/diagnose-branch-items.js --restaurant="some other"
//
// What it reports:
//   • The matching restaurant's _id, business_name
//   • Multi-branch mode: a console.table summary (one row per branch),
//     followed by detailed output for the newest branch AND every branch
//     where items exist but zero are MPM-eligible.
//   • Single-branch mode: detailed output for the resolved branch only.
//   • The 5 most recently created menu_items for the entire restaurant —
//     surfaces items inserted but never linked to any branch.
//
// No writes. Safe to run against prod.

const path = require('path');
const { connect, col } = require(path.join(__dirname, '..', 'src', 'config', 'database'));

const DEFAULT_RESTAURANT_QUERY = 'beyond snacks';

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

// Pull `--flag=value` pairs out of argv and treat the first remaining bare
// arg as the branch identifier. Unknown flags are warned about so silent
// typos in `--restaurant=` don't cause a confusing default-restaurant run.
function parseArgs(argv) {
  const out = { branchIdentifier: null, restaurantQuery: DEFAULT_RESTAURANT_QUERY };
  for (const raw of argv) {
    if (raw.startsWith('--restaurant=')) {
      out.restaurantQuery = raw.slice('--restaurant='.length);
    } else if (raw.startsWith('--')) {
      console.warn(`[diag] WARN: unrecognised flag ${raw} — ignored.`);
    } else if (out.branchIdentifier === null) {
      out.branchIdentifier = raw;
    } else {
      console.warn(`[diag] WARN: extra positional arg "${raw}" ignored.`);
    }
  }
  return out;
}

// Restaurant lookup. Tries exact `_id` first (so passing a string mongo id
// always works), then a case-insensitive regex over business_name /
// brand_name / name. Returns up to 5 matches so the caller can warn about
// ambiguity, picking the first as the active restaurant.
async function findRestaurant(query) {
  const byId = await col('restaurants').findOne({ _id: String(query) });
  if (byId) return { picked: byId, all: [byId] };
  const re = new RegExp(escapeRegex(query), 'i');
  const matches = await col('restaurants')
    .find({
      $or: [
        { business_name: { $regex: re } },
        { brand_name:    { $regex: re } },
        { name:          { $regex: re } },
      ],
    })
    .project({ _id: 1, business_name: 1, brand_name: 1, name: 1, created_at: 1 })
    .limit(5)
    .toArray();
  return { picked: matches[0] || null, all: matches };
}

// Resolve a user-typed branch identifier against the already-loaded list of
// branches. Match priority:
//   1. exact _id (string compare)
//   2. exact branch_slug (case-insensitive)
//   3. case-insensitive substring on `name`
// Returns { branch } on a unique match, or { branch: null, candidates }
// when the substring step matches multiple — caller prints them as a
// disambiguation list.
function resolveBranch(identifier, branches) {
  const id = String(identifier).trim();
  const lower = id.toLowerCase();
  const byId = branches.find((b) => String(b._id) === id);
  if (byId) return { branch: byId };
  const bySlug = branches.find((b) => String(b.branch_slug || '').toLowerCase() === lower);
  if (bySlug) return { branch: bySlug };
  const subMatches = branches.filter((b) =>
    String(b.name || '').toLowerCase().includes(lower)
  );
  if (subMatches.length === 1) return { branch: subMatches[0] };
  if (subMatches.length > 1) return { branch: null, candidates: subMatches };
  return { branch: null, candidates: [] };
}

// Six counts that drive both the summary table and the detailed view.
// Kept exactly as they were in the original — in particular `mpmEligible`
// stays scoped to the scalar `branch_id` field because that's what
// services/mpmBuilder.js queries on (do NOT switch this to $or without
// also updating the builder, otherwise the diagnostic will lie about
// what the MPM actually sees).
async function perBranchCounts(branchId) {
  const id = String(branchId);
  const [
    branchIdScalar,
    branchIdsArray,
    eitherTotal,
    eitherAvailable,
    eitherRetailer,
    mpmEligible,
  ] = await Promise.all([
    col('menu_items').countDocuments({ branch_id: id }),
    col('menu_items').countDocuments({ branch_ids: id }),
    col('menu_items').countDocuments({ $or: [{ branch_id: id }, { branch_ids: id }] }),
    col('menu_items').countDocuments({
      $or: [{ branch_id: id }, { branch_ids: id }],
      is_available: true,
    }),
    col('menu_items').countDocuments({
      $or: [{ branch_id: id }, { branch_ids: id }],
      retailer_id: { $exists: true, $nin: [null, ''] },
    }),
    col('menu_items').countDocuments({
      branch_id: id,
      is_available: true,
      retailer_id: { $exists: true, $nin: [null, ''] },
    }),
  ]);
  return {
    branchIdScalar,
    branchIdsArray,
    eitherTotal,
    eitherAvailable,
    eitherRetailer,
    mpmEligible,
  };
}

// Detailed per-branch output — same shape as the original NEWEST BRANCH
// section, parameterised over the supplied branch + counts. Used by both
// modes (single-branch with the resolved branch, multi-branch with the
// newest + every suspicious branch).
async function printBranchDetail(branch, counts) {
  const id = String(branch._id);
  header(`BRANCH DETAIL — branch_id=${id} (${branch.name || ''})`);

  console.log(`  count where branch_id  = id            : ${counts.branchIdScalar}`);
  console.log(`  count where branch_ids ∋ id            : ${counts.branchIdsArray}`);
  console.log(`  count where EITHER matches             : ${counts.eitherTotal}`);
  console.log(`  └─ of those, is_available: true        : ${counts.eitherAvailable}`);
  console.log(`  └─ of those, non-empty retailer_id     : ${counts.eitherRetailer}`);

  console.log('');
  console.log('  MPM builder filter (services/mpmBuilder.js:131-134) is exactly:');
  console.log('    { branch_id: <branchId>, is_available: true }');
  console.log('  + client-side `if (!item.retailer_id) continue` at line 160.');
  console.log('  Effective MPM-eligible count for this branch:');
  console.log(`    ${counts.mpmEligible} items would land in the MPM today.`);

  header('SAMPLE ITEMS (up to 3, full doc) — EITHER field match');
  const samples = await col('menu_items')
    .find({ $or: [{ branch_id: id }, { branch_ids: id }] })
    .sort({ created_at: -1, _id: -1 })
    .limit(3)
    .toArray();
  if (!samples.length) {
    console.log('  (no items match either field for this branch — likely cause B)');
  } else {
    for (const it of samples) {
      console.log('  ── item ──');
      console.log(JSON.stringify(it, null, 2).split('\n').map((ln) => '  ' + ln).join('\n'));
      console.log('');
    }
  }
}

// One-line interpretive note when MPM-eligible < the EITHER total. The
// "0 eligible despite items existing" case is the most damaging (entire
// branch invisible to MPM) but any gap is worth surfacing.
function printDiscrepancyNote(branch, counts) {
  if (counts.mpmEligible >= counts.eitherTotal) return;
  console.log(`  ⚠ ${branch.name || '(unnamed)'}: ${counts.eitherTotal} items linked, ${counts.mpmEligible} MPM-eligible.`);
  console.log('    Likely cause: items written via products API path (branch_ids only).');
}

(async () => {
  let exitCode = 0;
  try {
    const args = parseArgs(process.argv.slice(2));
    await connect();

    header(`RESTAURANT — match for "${args.restaurantQuery}"`);
    const { picked: restaurant, all: restaurants } = await findRestaurant(args.restaurantQuery);
    if (!restaurant) {
      console.log('  No restaurants matched. Aborting.');
      process.exit(2);
    }
    for (const r of restaurants) {
      console.log(`  _id:           ${r._id}`);
      console.log(`  business_name: ${r.business_name || '(none)'}`);
      console.log(`  brand_name:    ${r.brand_name || '(none)'}`);
      console.log(`  name:          ${r.name || '(none)'}`);
      console.log(`  created_at:    ${fmtDate(r.created_at)}`);
      console.log('');
    }
    if (restaurants.length > 1) {
      console.log('  ⚠ Multiple matches — using the first one for branch + item diagnostics.');
    }
    const restaurantId = String(restaurant._id);

    const branches = await col('branches')
      .find({ restaurant_id: restaurantId })
      .sort({ created_at: -1, _id: -1 })
      .toArray();
    if (!branches.length) {
      console.log('\n  No branches found. Aborting.');
      // Falls through to the finally block — exit 0 is fine, this is
      // diagnostic output, not a check.
      return;
    }

    if (args.branchIdentifier) {
      // ── Single-branch mode ────────────────────────────────────
      const { branch, candidates } = resolveBranch(args.branchIdentifier, branches);
      if (!branch) {
        if (candidates && candidates.length > 1) {
          console.log(`\n  ⚠ Branch identifier "${args.branchIdentifier}" matched ${candidates.length} branches:`);
          for (const c of candidates) {
            console.log(`    • ${c.name || '(no name)'} — slug=${c.branch_slug || '(none)'} — _id=${c._id}`);
          }
          console.log('  Re-run with the exact slug or _id to disambiguate.');
        } else {
          const rname = restaurant.business_name || restaurant.brand_name || restaurant.name || '(unnamed restaurant)';
          console.log(`\n  No branch matched "${args.branchIdentifier}" in restaurant ${rname}.`);
          console.log('  Available branches:');
          for (const c of branches) {
            console.log(`    • ${c.name || '(no name)'} — slug=${c.branch_slug || '(none)'} — _id=${c._id}`);
          }
        }
        return;
      }
      const counts = await perBranchCounts(branch._id);
      await printBranchDetail(branch, counts);
      if (counts.mpmEligible < counts.eitherTotal) {
        console.log('');
        printDiscrepancyNote(branch, counts);
      }
    } else {
      // ── Multi-branch mode ─────────────────────────────────────
      header(`BRANCHES (newest first) — restaurant_id=${restaurantId}`);
      // Compute counts per branch in parallel. A typical restaurant has
      // a handful to a few dozen branches and each call is six small
      // count queries against an indexed collection — bounded enough.
      const enriched = await Promise.all(branches.map(async (b) => {
        const c = await perBranchCounts(b._id);
        return { branch: b, counts: c };
      }));

      // Build the displayable rows separately from the rich objects so
      // console.table only renders the spec'd columns (no _full / _counts
      // junk leaking into the output).
      const tableRows = enriched.map(({ branch, counts }) => ({
        name: branch.name || '(none)',
        branch_slug: branch.branch_slug || '(none)',
        _id: String(branch._id).slice(-8),
        total_items_either_field: counts.eitherTotal,
        branch_id_scalar: counts.branchIdScalar,
        branch_ids_array: counts.branchIdsArray,
        is_available_true: counts.eitherAvailable,
        non_empty_retailer_id: counts.eitherRetailer,
        mpm_eligible: counts.mpmEligible,
        catalog_id_present: branch.catalog_id ? 'yes' : 'no',
      }));
      console.table(tableRows);

      // Discrepancy notes — fire on ANY gap between linked items and
      // MPM-eligible items, not just the strict "0 eligible" case. The
      // strict case still controls whether the detailed view runs below.
      const discrepancies = enriched.filter(({ counts }) => counts.mpmEligible < counts.eitherTotal);
      if (discrepancies.length) {
        console.log('');
        for (const d of discrepancies) printDiscrepancyNote(d.branch, d.counts);
      }

      // Detailed view: newest branch (always) + every "items exist but 0
      // MPM-eligible" branch. Suspicious is the strictest discrepancy
      // shape and worth eyeballing the sample docs for.
      const newest = enriched[0]; // already sorted newest-first
      await printBranchDetail(newest.branch, newest.counts);

      const newestId = String(newest.branch._id);
      const suspicious = enriched.filter(({ branch, counts }) =>
        counts.eitherTotal > 0 && counts.mpmEligible === 0 && String(branch._id) !== newestId
      );
      for (const s of suspicious) {
        await printBranchDetail(s.branch, s.counts);
      }
    }

    // ── 5 MOST RECENT ITEMS ACROSS THE RESTAURANT ────────────────
    // Restaurant-wide tail so the report still surfaces items that were
    // inserted but never linked to any branch (cause A).
    header(`5 MOST RECENT items in restaurant_id=${restaurantId}`);
    const recent = await col('menu_items')
      .find({ restaurant_id: restaurantId })
      .sort({ created_at: -1, _id: -1 })
      .limit(5)
      .project({
        _id: 1, name: 1, branch_id: 1, branch_ids: 1,
        is_available: 1, retailer_id: 1, catalog_sync_status: 1,
        created_at: 1, updated_at: 1,
      })
      .toArray();
    if (!recent.length) {
      console.log('  (none — implies cause A: items not landing in Mongo at all)');
    } else {
      for (const it of recent) {
        console.log(`  _id:               ${it._id}`);
        console.log(`  name:              ${it.name || '(none)'}`);
        console.log(`  branch_id:         ${it.branch_id == null ? '(null/missing)' : it.branch_id}`);
        console.log(`  branch_ids:        ${Array.isArray(it.branch_ids) ? JSON.stringify(it.branch_ids) : '(missing)'}`);
        console.log(`  is_available:      ${it.is_available === false ? 'false' : it.is_available === true ? 'true' : '(undefined)'}`);
        console.log(`  retailer_id:       ${it.retailer_id || '(missing)'}`);
        console.log(`  catalog_sync_status: ${it.catalog_sync_status || '(none)'}`);
        console.log(`  created_at:        ${fmtDate(it.created_at)}`);
        console.log('');
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
