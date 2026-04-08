// src/schemas/validate.js
// Lightweight document validation against schema contracts.
// Opt-in — call validateDocument() before writes. Does NOT change existing behavior.
// Returns { valid, errors } — never throws.

'use strict';

const { ALL_SCHEMAS } = require('./collections');

/**
 * Validate a document against its collection schema.
 * @param {string} collectionName - e.g. 'orders', 'menu_items'
 * @param {object} doc - The document to validate
 * @param {object} opts - { partial: true } for partial updates ($set)
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateDocument(collectionName, doc, opts = {}) {
  const schema = ALL_SCHEMAS[collectionName];
  if (!schema) return { valid: true, errors: [] }; // No schema defined — pass through

  const errors = [];
  const fields = schema.fields || {};
  const isPartial = opts.partial === true;

  for (const [fieldName, fieldDef] of Object.entries(fields)) {
    const value = doc[fieldName];

    // Required check (skip for partial updates)
    if (fieldDef.required && !isPartial && (value === undefined || value === null)) {
      errors.push(`${fieldName} is required`);
      continue;
    }

    // Skip if field not present
    if (value === undefined || value === null) continue;

    // Type check
    if (fieldDef.type) {
      const typeOk = checkType(value, fieldDef.type);
      if (!typeOk) {
        errors.push(`${fieldName}: expected ${fieldDef.type}, got ${typeof value}`);
      }
    }

    // Enum check
    if (fieldDef.enum && !fieldDef.enum.includes(value)) {
      errors.push(`${fieldName}: '${value}' not in [${fieldDef.enum.join(', ')}]`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function checkType(value, expectedType) {
  switch (expectedType) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && !isNaN(value);
    case 'boolean': return typeof value === 'boolean';
    case 'date':    return value instanceof Date || (typeof value === 'string' && !isNaN(Date.parse(value)));
    case 'array':   return Array.isArray(value);
    case 'object':  return typeof value === 'object' && !Array.isArray(value);
    case 'uuid':    return typeof value === 'string' && value.length >= 8;
    default:        return true;
  }
}

/**
 * Get the schema contract for a collection.
 */
function getSchema(collectionName) {
  return ALL_SCHEMAS[collectionName] || null;
}

/**
 * List all defined collection schemas.
 */
function listSchemas() {
  return Object.keys(ALL_SCHEMAS);
}

module.exports = { validateDocument, getSchema, listSchemas };
