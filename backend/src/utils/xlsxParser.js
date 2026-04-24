// src/utils/xlsxParser.js
// Thin wrapper around `exceljs` — converts the first sheet of an XLSX
// buffer to an array of header-keyed JSON rows.
//
// Migrated from the unmaintained `xlsx` (SheetJS) npm package, which
// shipped two unfixed advisories (prototype pollution + ReDoS,
// GHSA-4r6h-8v6p-xvw6 / GHSA-5pgg-2g8v-p4x9). exceljs is already a
// dependency for output, so reuse it for input too — no new package.
//
// We intentionally do NOT do any column normalisation / mapping here.
// The spec is "store raw_data as-is" — mapping happens in a later pass.
//
// Note: parseXlsxBuffer() is now ASYNC (exceljs has no sync-from-buffer
// reader). Both call sites already sit inside async functions, so the
// migration cost is just adding `await` at the consumer.

'use strict';

const ExcelJS = require('exceljs');

// Convert one exceljs cell value to the same string form `xlsx`'s
// `sheet_to_json({ raw: false, defval: '' })` used to emit. Downstream
// importers (menuMapping + restaurant.js CSV handler) call parseFloat /
// parseInt / .toLowerCase on these, so stringifying preserves their
// existing assumptions.
function _normalizeCell(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    // exceljs wraps richer cell types in objects — unwrap the most
    // common ones to a plain string. Order matters: hyperlink BEFORE
    // formula (a formula cell with hyperlink result has both).
    if (typeof v.text === 'string') return v.text;                                // hyperlink
    if (Array.isArray(v.richText)) return v.richText.map(p => p?.text || '').join('');
    if (v.result != null) return _normalizeCell(v.result);                        // formula
    if (v.formula != null) return '';                                             // formula with no cached result
    if (v.error) return '';                                                       // #DIV/0!, #N/A, etc.
    return String(v);
  }
  return String(v);
}

/**
 * Parse an XLSX buffer into JSON rows, one per row of the first sheet.
 * The first row is treated as the header row.
 *
 * @param {Buffer} buffer  raw .xlsx bytes
 * @returns {Promise<{ sheetName: string, rowCount: number, rows: Array<Object> }>}
 */
async function parseXlsxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('Empty or invalid file buffer');
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('Workbook has no sheets');
  const sheetName = sheet.name;

  // exceljs row.values is 1-indexed (index 0 is always undefined).
  // Pull headers from row 1 then build {header: cell} objects for the
  // remaining rows. Rows where every cell is empty are skipped, mirroring
  // the prior xlsx sheet_to_json behaviour.
  const headerRow = sheet.getRow(1);
  if (!headerRow || headerRow.cellCount === 0) {
    return { sheetName, rowCount: 0, rows: [] };
  }
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = _normalizeCell(cell.value).trim();
  });

  const rows = [];
  const lastRow = sheet.actualRowCount || sheet.rowCount;
  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    if (!row || row.cellCount === 0) continue;

    const obj = {};
    let hasAny = false;
    for (let c = 1; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      const val = _normalizeCell(row.getCell(c).value);
      // defval: '' parity — keep empty cells as '' rather than dropping the key.
      obj[key] = val;
      if (val !== '') hasAny = true;
    }
    if (hasAny) rows.push(obj);
  }

  return { sheetName, rowCount: rows.length, rows };
}

module.exports = { parseXlsxBuffer };
