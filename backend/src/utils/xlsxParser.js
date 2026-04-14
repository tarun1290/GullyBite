// src/utils/xlsxParser.js
// Thin wrapper around the `xlsx` library — converts the first sheet of
// an XLSX buffer to an array of header-keyed JSON rows.
//
// Install once:  npm i xlsx
//
// We intentionally do NOT do any column normalisation / mapping here.
// The spec is "store raw_data as-is" — mapping happens in a later pass.

'use strict';

let _xlsx = null;
function _lib() {
  if (_xlsx) return _xlsx;
  try { _xlsx = require('xlsx'); }
  catch (e) {
    const err = new Error('xlsx package is not installed. Run: npm i xlsx');
    err.cause = e;
    throw err;
  }
  return _xlsx;
}

/**
 * Parse an XLSX buffer into JSON rows, one per row of the first sheet.
 * Header row is auto-detected (first row by default).
 *
 * @param {Buffer} buffer  raw .xlsx bytes
 * @returns {{ sheetName: string, rowCount: number, rows: Array<Object> }}
 */
function parseXlsxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('Empty or invalid file buffer');
  }
  const xlsx = _lib();
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Workbook has no sheets');
  const sheet = wb.Sheets[sheetName];
  // defval: '' avoids holes for empty cells; raw: false stringifies dates etc.
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });
  return { sheetName, rowCount: rows.length, rows };
}

module.exports = { parseXlsxBuffer };
