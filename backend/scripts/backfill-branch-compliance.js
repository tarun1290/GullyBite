#!/usr/bin/env node
// scripts/backfill-branch-compliance.js
//
// Interactive backfill for a single restaurant's branch compliance fields
// (fssai_number, gst_number) that existed before the legacy POST /branches
// handler was taught to persist them.
//
// Run on EC2 after gathering FSSAI certificates + GST certificates from the
// restaurant:
//
//   cd /home/ubuntu/GullyBite/backend
//   node scripts/backfill-branch-compliance.js
//
// Prompts per branch. Blank input = leave field unchanged. Ctrl+C to abort.
// No writes happen until you confirm at the final summary prompt.
//
// Read-only until the explicit "y" confirmation at the end.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { MongoClient } = require('mongodb');
const readline = require('readline');

const RESTAURANT_ID = 'c6ea1846-7aa8-4a65-b18d-2fea78960e26';
const FSSAI_RE = /^\d{14}$/;
const GST_RE   = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function prompt(rl, q) {
  return new Promise((resolve) => rl.question(q, (ans) => resolve(ans)));
}

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('FATAL: MONGODB_URI is not set');
    process.exit(1);
  }

  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const db = client.db(process.env.MONGODB_DB || 'gullybite');
  const col = db.collection('branches');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const branches = await col
      .find({ restaurant_id: RESTAURANT_ID })
      .sort({ created_at: 1 })
      .toArray();

    if (branches.length === 0) {
      console.error(`No branches found for restaurant ${RESTAURANT_ID}`);
      return;
    }

    console.log(`\nFound ${branches.length} branch${branches.length === 1 ? '' : 'es'} for restaurant ${RESTAURANT_ID}:\n`);
    for (const b of branches) {
      console.log(`  ${b.name}  (${b._id})`);
      console.log(`    current fssai_number: ${b.fssai_number ?? '(unset)'}`);
      console.log(`    current gst_number:   ${b.gst_number ?? '(unset)'}`);
    }
    console.log('');

    const updates = [];
    for (const b of branches) {
      console.log(`\n── ${b.name} ──`);
      let fssai = null;
      while (true) {
        const ans = (await prompt(rl, `  New fssai_number (14 digits, blank to skip): `)).trim();
        if (ans === '') { fssai = null; break; }
        if (!FSSAI_RE.test(ans)) {
          console.log('  ✗ not 14 digits — try again or blank to skip');
          continue;
        }
        fssai = ans;
        break;
      }

      let gst = null;
      while (true) {
        const ans = (await prompt(rl, `  New gst_number (15-char GSTIN, blank to skip): `)).trim().toUpperCase();
        if (ans === '') { gst = null; break; }
        if (!GST_RE.test(ans)) {
          console.log('  ✗ not a valid 15-char GSTIN — try again or blank to skip');
          continue;
        }
        gst = ans;
        break;
      }

      if (fssai === null && gst === null) {
        console.log('  (no changes for this branch)');
        continue;
      }
      updates.push({
        _id: b._id,
        name: b.name,
        current_fssai: b.fssai_number ?? null,
        current_gst:   b.gst_number ?? null,
        new_fssai: fssai,
        new_gst:   gst,
      });
    }

    if (updates.length === 0) {
      console.log('\nNothing to update. Exiting.');
      return;
    }

    console.log('\n── Summary (DRY RUN — nothing written yet) ──');
    for (const u of updates) {
      console.log(`  ${u.name} (${u._id})`);
      if (u.new_fssai !== null) console.log(`    fssai_number: ${u.current_fssai ?? '(unset)'}  →  ${u.new_fssai}`);
      if (u.new_gst   !== null) console.log(`    gst_number:   ${u.current_gst   ?? '(unset)'}  →  ${u.new_gst}`);
    }

    const confirm = (await prompt(rl, '\nApply these updates to MongoDB? (y/N): ')).trim().toLowerCase();
    if (confirm !== 'y') {
      console.log('Aborted. No writes made.');
      return;
    }

    for (const u of updates) {
      const $set = { updated_at: new Date() };
      if (u.new_fssai !== null) $set.fssai_number = u.new_fssai;
      if (u.new_gst   !== null) $set.gst_number   = u.new_gst;
      await col.updateOne({ _id: u._id }, { $set });
      console.log(`  ✓ ${u.name}  updated (${Object.keys($set).filter(k => k !== 'updated_at').join(', ')})`);
    }
    console.log('\nDone.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exitCode = 1;
  } finally {
    rl.close();
    await client.close();
  }
})();
