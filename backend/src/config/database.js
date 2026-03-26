// src/config/database.js
// MongoDB connection — replaces PostgreSQL/pg

const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');

// Connection pool options — optimized for Vercel serverless
const POOL_OPTIONS = {
  maxPoolSize: 10,
  minPoolSize: 2,
  maxIdleTimeMS: 60000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 10000,
  serverSelectionTimeoutMS: 5000,
  retryWrites: true,
  retryReads: true,
};

// Cache client/db at module scope — survives across warm invocations in Vercel
let _client = global._mongoClient || null;
let _db = global._mongoDb || null;
let _connectPromise = global._mongoConnectPromise || null;

const connect = async () => {
  if (_db) return _db;
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

// Connect on startup — store rejected promise for ensureConnected to retry
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
  if (_db) return next(); // already connected (warm start)
  try {
    // If initial connect succeeded, await it; otherwise retry
    if (_connectPromise) {
      await _connectPromise;
    } else {
      await connect();
    }
  } catch (_) {
    // First attempt failed — retry once (handles Vercel cold-start race)
    try {
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
