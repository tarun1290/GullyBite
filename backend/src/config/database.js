// src/config/database.js
// PostgreSQL connection using the 'pg' library
// A "pool" = multiple DB connections kept open and reused for speed

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // SSL required for cloud databases (Neon, Supabase, Heroku, etc.)
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection FAILED:', err.message);
    return; // don't crash — Vercel serverless can't process.exit
  }
  console.log('✅ Database connected');
  release();
});

// ─── QUERY HELPER ─────────────────────────────────────────────
// Use this everywhere instead of pool.query directly
// It adds logging and consistent error handling
// 
// Usage examples:
//   const { rows } = await db.query('SELECT * FROM orders WHERE id=$1', [orderId])
//   const { rows } = await db.query('INSERT INTO orders (...) VALUES (...) RETURNING *', [...])
const query = async (sql, params = []) => {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    console.error('DB Error:', err.message, '| SQL:', sql.slice(0, 100));
    throw err;
  }
};

// ─── TRANSACTION HELPER ───────────────────────────────────────
// For operations that must ALL succeed or ALL fail together
// Example: creating order + updating customer stats + deducting stock
//
// Usage:
//   await db.transaction(async (client) => {
//     await client.query('INSERT INTO orders ...')
//     await client.query('UPDATE customers SET total_orders = ...')
//   })
const transaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ─── SCHEMA SETUP ─────────────────────────────────────────────
// Called by: npm run db:setup
// Reads schema.sql and creates all tables
const runSetup = async () => {
  const schemaPath = path.join(__dirname, '../models/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ All database tables created!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Schema setup failed:', err.message);
    process.exit(1);
  }
};

module.exports = { query, transaction, pool, runSetup };