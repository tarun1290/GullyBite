// src/config/database.js
// MongoDB connection — replaces PostgreSQL/pg

const { MongoClient, GridFSBucket } = require('mongodb');
const { v4: uuidv4 } = require('uuid');

let _client = null;
let _db = null;
let _bucket = null;
let _connectPromise = null;

const connect = async () => {
  if (_db) return _db;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI env var is not set');
  _client = new MongoClient(process.env.MONGODB_URI);
  await _client.connect();
  _db = _client.db(process.env.MONGODB_DB || 'gullybite');
  _bucket = new GridFSBucket(_db, { bucketName: 'images' });
  console.log('✅ MongoDB connected');
  return _db;
};

// Connect on startup — store the promise so middleware can await it
_connectPromise = connect().catch(err => {
  console.error('❌ MongoDB connection FAILED:', err.message);
});

// Middleware: ensures DB is connected before any route runs
const ensureConnected = async (req, res, next) => {
  if (!_db) {
    try { await _connectPromise; } catch (err) {
      return res.status(503).json({ error: 'Database unavailable: ' + err.message });
    }
  }
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

// Get the GridFS bucket for image storage
const getBucket = () => {
  if (!_bucket) throw new Error('MongoDB not connected yet');
  return _bucket;
};

module.exports = { col, transaction, connect, ensureConnected, mapId, mapIds, newId, getBucket };
