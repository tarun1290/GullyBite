// src/utils/adminAudit.js
// Fire-and-forget audit logger for admin RBAC actions. Always wrapped
// in its own try/catch so an insert failure cannot break the calling
// request — audit gaps are preferable to user-visible 500s on admin
// writes.

'use strict';

const log = require('./logger').child({ component: 'adminAudit' });

async function logAdminAction(db, adminUserId, action, entityType, entityId, cityId, beforeState, afterState, ip) {
  try {
    await db.collection('admin_audit_logs').insertOne({
      admin_user_id: adminUserId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      city_id: cityId,
      before_state: beforeState,
      after_state: afterState,
      ip,
      ts: new Date(),
    });
  } catch (err) {
    log.warn({ err, action, entityType, entityId }, 'admin audit log insert failed (swallowed)');
  }
}

module.exports = { logAdminAction };
