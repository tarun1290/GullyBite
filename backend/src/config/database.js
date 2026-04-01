// src/config/database.js
// MongoDB connection — optimized for Vercel serverless (cached across warm invocations)

const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');

// Serverless-optimized pool: minimal connections, fast timeouts
const POOL_OPTIONS = {
  maxPoolSize: 1,           // One connection per serverless instance
  minPoolSize: 0,           // Allow pool to shrink to zero when idle
  maxIdleTimeMS: 10000,     // Close idle connections after 10s
  connectTimeoutMS: 10000,  // Fail fast — don't hang for 2 minutes
  socketTimeoutMS: 45000,   // Socket operations timeout
  serverSelectionTimeoutMS: 10000, // Don't wait forever to find a server
  retryWrites: true,
  retryReads: true,
};

// Module-level cache — survives across warm invocations in Vercel
let _client = global._mongoClient || null;
let _db = global._mongoDb || null;
let _connectPromise = global._mongoConnectPromise || null;

function _isAlive() {
  try { return _client?.topology?.isConnected?.() !== false; } catch { return false; }
}

const connect = async () => {
  // Check if existing connection is truly alive (not just cached but stale)
  if (_db && _isAlive()) return _db;

  // Stale connection — discard and reconnect
  if (_client && !_isAlive()) {
    console.log('[DB] Stale connection detected — reconnecting');
    try { _client.close().catch(() => {}); } catch {}
    _client = null; _db = null;
    global._mongoClient = null; global._mongoDb = null;
  }

  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI env var is not set');
  const start = Date.now();
  _client = new MongoClient(process.env.MONGODB_URI, POOL_OPTIONS);
  await _client.connect();
  _db = _client.db(process.env.MONGODB_DB || 'gullybite');
  // Cache on global for Vercel warm starts
  global._mongoClient = _client;
  global._mongoDb = _db;
  console.log(`✅ MongoDB connected (${Date.now() - start}ms)`);
  return _db;
};

// Connect on startup — non-blocking, stores promise for ensureConnected to await
if (!_connectPromise) {
  _connectPromise = connect().catch(err => {
    console.error('❌ MongoDB connection FAILED:', err.message);
    _connectPromise = null;
    global._mongoConnectPromise = null;
  });
  global._mongoConnectPromise = _connectPromise;
}

// Middleware: ensures DB is connected before any route runs
const ensureConnected = async (req, res, next) => {
  if (_db && _isAlive()) return next(); // already connected (warm start)
  try {
    if (_connectPromise) {
      await _connectPromise;
    } else {
      await connect();
    }
  } catch (_) {
    // First attempt failed — retry once (handles Vercel cold-start race)
    try {
      _connectPromise = null;
      global._mongoConnectPromise = null;
      await connect();
    } catch (err) {
      console.error('❌ DB unavailable on retry:', err.message);
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
