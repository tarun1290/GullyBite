// src/config/database.js
// MongoDB connection — optimized for Vercel serverless (cached across warm invocations)

const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const log = require('../utils/logger').child({ component: 'database' });

// Serverless-optimized pool: minimal connections, aggressive timeouts
// NOTE: If using mongodb+srv://, DNS SRV resolution adds 5-15s BEFORE these timeouts apply.
// Use standard mongodb:// with explicit hosts to eliminate DNS delay on cold starts.
const POOL_OPTIONS = {
  maxPoolSize: 5,           // Up to 5 connections per serverless instance
  minPoolSize: 0,           // Allow pool to shrink to zero when idle
  maxIdleTimeMS: 10000,     // Close idle connections after 10s
  connectTimeoutMS: 5000,   // TCP connection timeout — fail fast
  socketTimeoutMS: 30000,   // Socket operations timeout
  serverSelectionTimeoutMS: 5000, // Find a server within 5s or fail
  retryWrites: true,
  retryReads: true,
};

// Module-level cache — survives across warm invocations in Vercel and
// across pm2 process lifetime on EC2. `_connectPromise` is the single
// in-flight connect; concurrent callers await the same promise so we
// never race a close() against a half-connected client.
let _client = global._mongoClient || null;
let _db = global._mongoDb || null;
let _connectPromise = global._mongoConnectPromise || null;

function _isAlive() {
  try { return _client?.topology?.isConnected?.() !== false; } catch { return false; }
}

// Public entry point — single-flight. Returns the cached db on warm hits,
// otherwise dedupes concurrent reconnect callers onto one promise. The
// old version started a parallel reconnect on every call, which closed
// the still-connecting client owned by the first call → spurious
// MongoTopologyClosedError on every cold start / idle wakeup.
const connect = async () => {
  if (_db && _isAlive()) return _db;
  if (_connectPromise) return _connectPromise;
  _connectPromise = _doConnect()
    .finally(() => {
      _connectPromise = null;
      global._mongoConnectPromise = null;
    });
  global._mongoConnectPromise = _connectPromise;
  return _connectPromise;
};

// The actual reconnect work. Runs at most once at a time thanks to the
// _connectPromise gate above. Three invariants this enforces that the
// old code didn't:
//   1. close() is AWAITED before we open a new client.
//   2. The new client is only committed to module scope (_client / _db)
//      AFTER `await client.connect()` resolves — so _isAlive() never
//      returns false on a doc that another caller is about to interpret
//      as "stale, kill it".
//   3. MongoTopologyClosedError on close() is swallowed (expected during
//      teardown), other close() errors are warned but don't block the
//      reconnect.
async function _doConnect() {
  // Tear down a previous client if any. close() is awaited so the new
  // client.connect() below cannot race against an in-flight close.
  if (_client) {
    log.info('Stale connection detected — reconnecting');
    const stale = _client;
    _client = null;
    _db = null;
    global._mongoClient = null;
    global._mongoDb = null;
    try {
      await stale.close();
    } catch (err) {
      // MongoTopologyClosedError is the "already closed" case — expected
      // when a teardown has already happened on another path. Other
      // errors are surfaced at warn level (not error) because the next
      // step is to open a fresh client anyway.
      const isAlreadyClosed = err && err.name === 'MongoTopologyClosedError';
      if (!isAlreadyClosed) {
        log.warn({ err: err && err.message ? err.message : String(err) },
          'Stale client close errored — continuing with reconnect');
      }
    }
  }

  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI env var is not set');
  const isSrv = process.env.MONGODB_URI.startsWith('mongodb+srv://');
  const start = Date.now();
  log.info({ isSrv }, 'Connecting to MongoDB');
  const newClient = new MongoClient(process.env.MONGODB_URI, POOL_OPTIONS);
  await newClient.connect();
  // Commit to module scope only after the handshake completes. This is
  // the key fix for the "second connect() sees _client set but
  // _isAlive() false → triggers stale path → closes the in-flight
  // client" race.
  _client = newClient;
  _db = newClient.db(process.env.MONGODB_DB || 'gullybite');
  global._mongoClient = _client;
  global._mongoDb = _db;
  const elapsed = Date.now() - start;
  log.info({ elapsedMs: elapsed, slow: elapsed > 5000 }, `MongoDB connected (${elapsed}ms)`);
  return _db;
}

// Connect on startup — non-blocking. The first connect() call seeds
// _connectPromise via the gate inside connect() itself, so a route or
// script that calls connect() / ensureConnected() within the next few
// hundred ms simply awaits the same promise rather than racing it.
if (!_connectPromise) {
  connect().catch(err => {
    log.error({ err }, 'MongoDB connection FAILED');
  });
}

// Middleware: ensures DB is connected before any route runs. Simplified
// from the old version — connect() now handles the in-flight gating,
// so this just awaits it. One retry is preserved for the cold-start
// race where the very first connect rejected (e.g. Atlas DNS hiccup).
const ensureConnected = async (req, res, next) => {
  if (_db && _isAlive()) return next();
  try {
    await connect();
  } catch (_) {
    try {
      await connect();
    } catch (err) {
      log.error({ err }, 'DB unavailable on retry');
      return res.status(503).json({ error: 'Database unavailable — ' + err.message });
    }
  }
  if (!_db) return res.status(503).json({ error: 'Database unavailable' });
  next();
};

// Get a collection (synchronous — only call after ensureConnected)
const col = (name) => {
  if (!_db) throw new Error('MongoDB not connected yet');
  return _db.collection(name);
};

// Transaction helper using MongoDB sessions
// fn receives session; pass { session } to every collection op inside fn
const transaction = async (fn) => {
  const session = _client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

// Add id = _id to document(s) for code compatibility
const mapId  = (doc) => doc ? { ...doc, id: String(doc._id) } : null;
const mapIds = (arr) => (arr || []).map(mapId);

// Generate new UUID (used as _id)
const newId = () => uuidv4();

/* ═══ FUTURE FEATURE: GridFS Bucket for File Storage ═══
   MongoDB GridFS was used for image storage before S3 migration.
   Re-enable if GridFS-based file serving is needed (e.g., document uploads).
   Requires: const { MongoClient, GridFSBucket } = require('mongodb');
   Add _bucket initialization in connect(): _bucket = new GridFSBucket(_db, { bucketName: 'images' });

   let _bucket = null;
   const getBucket = () => {
     if (!_bucket) throw new Error('MongoDB not connected yet');
     return _bucket;
   };
   // Add getBucket to module.exports
   ═══ END FUTURE FEATURE ═══ */

module.exports = { col, transaction, connect, ensureConnected, mapId, mapIds, newId };
