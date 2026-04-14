// src/middleware/validateBranch.js
// Request validators for branch and product endpoints. Thin — delegates
// actual format checks to the service-layer validators so the rules live
// in one place.

'use strict';

const branchSvc = require('../services/branch.service');

function requireFields(fields) {
  return (req, res, next) => {
    for (const f of fields) {
      if (req.body[f] == null || req.body[f] === '') {
        return res.status(400).json({ error: `${f} is required` });
      }
    }
    next();
  };
}

function validateBranchPayload(req, res, next) {
  const { fssai_number, gst_number } = req.body || {};
  const fssai = branchSvc.validateFssai(fssai_number);
  if (!fssai.ok) return res.status(400).json({ error: fssai.reason });
  const gst = branchSvc.validateGst(gst_number);
  if (!gst.ok) return res.status(400).json({ error: gst.reason });
  // Normalise into the request so the controller writes the canonical form.
  req.body.fssai_number = fssai.normalized;
  req.body.gst_number   = gst.normalized;
  next();
}

function validateAssignBranchPayload(req, res, next) {
  const { branch_id, price } = req.body || {};
  if (!branch_id) return res.status(400).json({ error: 'branch_id is required' });
  if (price != null && (Number.isNaN(Number(price)) || Number(price) < 0)) {
    return res.status(400).json({ error: 'price must be a non-negative number' });
  }
  next();
}

module.exports = {
  requireFields,
  validateBranchPayload,
  validateAssignBranchPayload,
};
