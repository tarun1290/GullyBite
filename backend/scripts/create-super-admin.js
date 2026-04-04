#!/usr/bin/env node
// create-super-admin.js
// Creates the initial super admin account. Idempotent — skips if super_admin already exists.
//
// Usage:
//   SUPER_ADMIN_EMAIL=tarun@gullybite.com SUPER_ADMIN_PASSWORD=secure123 node backend/scripts/create-super-admin.js
//   or: node backend/scripts/create-super-admin.js (reads from .env)

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const bcrypt = require('bcryptjs');
const { connect, col, newId } = require('../src/config/database');

async function main() {
  await connect();

  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('ERROR: Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD environment variables');
    process.exit(1);
  }

  // Check if super admin already exists
  const existing = await col('admin_users').findOne({ role: 'super_admin' });
  if (existing) {
    console.log(`Super admin already exists: ${existing.email}`);
    console.log('To create another, remove the existing one first.');
    setTimeout(() => process.exit(0), 500);
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  const doc = {
    _id: newId(),
    email: email.toLowerCase().trim(),
    password_hash: hash,
    name: 'Super Admin',
    phone: null,
    role: 'super_admin',
    permissions: {}, // super_admin bypasses all permission checks
    is_active: true,
    last_login: null,
    login_count: 0,
    created_by: 'seed',
    created_at: new Date(),
    updated_at: new Date(),
  };

  await col('admin_users').insertOne(doc);
  console.log(`Super admin created: ${email}`);
  console.log('You can now log in to the admin dashboard.');

  // Create index
  await col('admin_users').createIndex({ email: 1 }, { unique: true }).catch(() => {});

  setTimeout(() => process.exit(0), 500);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
