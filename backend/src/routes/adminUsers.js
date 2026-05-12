// src/routes/adminUsers.js
// RBAC admin user management. All routes are super_admin only and
// mounted at /api/admin (see ec2-server.js). Sits in front of the
// legacy /api/admin/users handlers in routes/admin.js so the new
// role/cities/is_active flow is the canonical one.

'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { col, connect, newId, mapId, mapIds } = require('../config/database');
const { requireRole } = require('./auth');
const { logAdminAction } = require('../utils/adminAudit');
const log = require('../utils/logger').child({ component: 'adminUsers' });

const ROLES = new Set(['super_admin', 'city_ops', 'sales']);

function stripSensitive(doc) {
  if (!doc) return doc;
  const { password_hash, ...rest } = doc;
  return rest;
}

// GET /api/admin/me — current authenticated admin user
router.get('/me', ...requireRole(['super_admin', 'city_ops', 'sales']), async (req, res) => {
  try {
    res.json(mapId(stripSensitive(req.adminUser)));
  } catch (err) {
    log.error({ err }, 'GET /api/admin/me failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/users — list all admin users
router.get('/users', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const users = await col('admin_users')
      .find({}, { projection: { password_hash: 0 } })
      .sort({ created_at: -1 })
      .toArray();
    res.json(mapIds(users));
  } catch (err) {
    log.error({ err }, 'GET /api/admin/users failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/users — create admin user with role + cities
router.post('/users', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const { email, password, name, phone, role, cities } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (!ROLES.has(role)) return res.status(400).json({ error: 'invalid role' });
    if (cities !== undefined && !Array.isArray(cities)) return res.status(400).json({ error: 'cities must be an array' });

    const hash = await bcrypt.hash(password, 12);
    const doc = {
      _id: newId(),
      email: String(email).toLowerCase().trim(),
      password_hash: hash,
      name: name || '',
      phone: phone || null,
      role,
      cities: Array.isArray(cities) ? cities.map(String) : [],
      permissions: {},
      is_active: true,
      last_login: null,
      login_count: 0,
      token_version: 0,
      created_by: req.adminUser?._id || null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    await col('admin_users').insertOne(doc);

    const db = await connect();
    logAdminAction(
      db,
      req.adminUser?._id,
      'admin_user.create',
      'admin_user',
      doc._id,
      null,
      null,
      stripSensitive(doc),
      req.ip,
    );

    res.json(mapId(stripSensitive(doc)));
  } catch (err) {
    if (err && err.code === 11000) return res.status(400).json({ error: 'Email already in use' });
    log.error({ err }, 'POST /api/admin/users failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/admin/users/:id — update role, cities, is_active
router.patch('/users/:id', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const target = await col('admin_users').findOne({ _id: req.params.id });
    if (!target) return res.status(404).json({ error: 'Admin user not found' });

    const { role, cities, is_active } = req.body || {};
    const $set = { updated_at: new Date() };

    if (role !== undefined) {
      if (!ROLES.has(role)) return res.status(400).json({ error: 'invalid role' });
      $set.role = role;
    }
    if (cities !== undefined) {
      if (!Array.isArray(cities)) return res.status(400).json({ error: 'cities must be an array' });
      $set.cities = cities.map(String);
    }
    if (is_active !== undefined) $set.is_active = !!is_active;

    const $update = { $set };
    // Deactivation invalidates outstanding JWTs (matches the legacy
    // PUT /users/:id behaviour in routes/admin.js).
    if (is_active === false) $update.$inc = { token_version: 1 };

    await col('admin_users').updateOne({ _id: req.params.id }, $update);
    const after = await col('admin_users').findOne({ _id: req.params.id }, { projection: { password_hash: 0 } });

    const db = await connect();
    logAdminAction(
      db,
      req.adminUser?._id,
      'admin_user.update',
      'admin_user',
      req.params.id,
      null,
      stripSensitive(target),
      after,
      req.ip,
    );

    res.json(mapId(after));
  } catch (err) {
    log.error({ err }, 'PATCH /api/admin/users/:id failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/users/:id — soft delete (is_active: false), never hard delete
router.delete('/users/:id', ...requireRole(['super_admin']), async (req, res) => {
  try {
    const target = await col('admin_users').findOne({ _id: req.params.id });
    if (!target) return res.status(404).json({ error: 'Admin user not found' });

    await col('admin_users').updateOne(
      { _id: req.params.id },
      { $set: { is_active: false, updated_at: new Date() }, $inc: { token_version: 1 } },
    );

    const db = await connect();
    logAdminAction(
      db,
      req.adminUser?._id,
      'admin_user.soft_delete',
      'admin_user',
      req.params.id,
      null,
      stripSensitive(target),
      { ...stripSensitive(target), is_active: false },
      req.ip,
    );

    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'DELETE /api/admin/users/:id failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
