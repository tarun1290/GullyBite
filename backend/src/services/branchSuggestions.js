// src/services/branchSuggestions.js
// Smart bulk branch-mapping SUGGESTIONS.
//
// Pure suggestion layer — never writes to the DB. The dashboard fetches
// these proposals, lets the operator review/edit, and then submits the
// chosen mapping through the existing /assign-branch endpoint.
//
// Heuristic order (cheapest → broadest):
//   1. Name-keyword match → product names containing a branch name,
//      city, or area get pinned to that branch.
//   2. Category clustering → if multiple branches share the same
//      category specialisation (stamped on branch.specialty_categories
//      or branch.tags), every product in that category is suggested
//      for those branches.
//   3. Fallback → suggest ALL active branches for every product.
//
// Each pass appends to the suggestion set; we never override a stronger
// signal with a weaker one. Returns a stable, ordered array so the UI
// can render diff-friendly rows.

'use strict';

const branchSvc  = require('./branch.service');
const productSvc = require('./product.service');
const { col }    = require('../config/database');

function _norm(s) { return String(s || '').toLowerCase().trim(); }

// Build the per-branch keyword index used by pass 1.
// Keywords come from: branch.name, branch.city, branch.area,
// branch.locality, plus any whitespace-separated tokens of name >= 3
// chars (so "Indiranagar" matches even when the product is "Burger – Indiranagar").
function _branchKeywords(branch) {
  const set = new Set();
  const push = v => {
    const n = _norm(v);
    if (n && n.length >= 3) set.add(n);
  };
  push(branch.name);
  push(branch.city);
  push(branch.area);
  push(branch.locality);
  // Tokenise the name for multi-word matches.
  _norm(branch.name).split(/[^a-z0-9]+/).forEach(t => { if (t.length >= 4) set.add(t); });
  return [...set];
}

// Pass 1 — name keyword.
function _matchByName(productName, branches) {
  const n = _norm(productName);
  if (!n) return [];
  const hits = [];
  for (const b of branches) {
    const kws = _branchKeywords(b);
    if (kws.some(k => n.includes(k))) hits.push(String(b._id));
  }
  return hits;
}

// Pass 2 — category clustering.
// branch.specialty_categories can be ['Pizza','Beverages']; if a
// product's category matches, that branch is suggested.
function _matchByCategory(productCategory, branches) {
  const cat = _norm(productCategory);
  if (!cat || cat === 'general') return [];
  const hits = [];
  for (const b of branches) {
    const specs = (b.specialty_categories || b.tags || []).map(_norm);
    if (specs.includes(cat)) hits.push(String(b._id));
  }
  return hits;
}

// Pass 3 — fallback to all active branches.
function _allBranchIds(branches) {
  return branches.filter(branchSvc.isOperational).map(b => String(b._id));
}

/**
 * Suggest branch_ids for each product. Pure function, no DB writes.
 * @param {Array<{_id, name, category_name?, category?}>} products
 * @param {Array<{_id, name, city?, area?, is_active?, specialty_categories?}>} branches
 * @returns {Array<{product_id, suggested_branch_ids: string[], reason: string}>}
 */
function suggestBranchMapping(products, branches) {
  if (!Array.isArray(products) || products.length === 0) return [];
  if (!Array.isArray(branches) || branches.length === 0) return [];

  const allActive = _allBranchIds(branches);

  return products.map(p => {
    const byName = _matchByName(p.name, branches);
    if (byName.length) {
      return { product_id: String(p._id), suggested_branch_ids: byName, reason: 'name_match' };
    }
    const byCat = _matchByCategory(p.category_name || p.category, branches);
    if (byCat.length) {
      return { product_id: String(p._id), suggested_branch_ids: byCat, reason: 'category_cluster' };
    }
    return { product_id: String(p._id), suggested_branch_ids: allActive, reason: 'all_active_fallback' };
  });
}

/**
 * Restaurant-scoped helper used by the route. Pulls fresh branches and
 * (by default) only unassigned products — operators usually only need
 * suggestions for products that haven't been mapped yet.
 *
 * @param {string} restaurantId
 * @param {{ scope?: 'unassigned'|'all', product_ids?: string[] }} opts
 */
async function suggestForRestaurant(restaurantId, opts = {}) {
  const branches = await branchSvc.listBranchesByRestaurant(restaurantId);
  let products;
  if (Array.isArray(opts.product_ids) && opts.product_ids.length) {
    products = await col('menu_items').find({
      retailer_id: String(restaurantId),
      _id: { $in: opts.product_ids.map(String) },
    }).toArray();
  } else if (opts.scope === 'all') {
    products = await col('menu_items').find({ retailer_id: String(restaurantId) }).toArray();
  } else {
    products = await productSvc.listUnassignedProducts(restaurantId);
  }
  return suggestBranchMapping(products, branches);
}

module.exports = {
  suggestBranchMapping,
  suggestForRestaurant,
};
