// src/services/catalogCompression/index.js
// Public API for the Catalog Compression Engine.

'use strict';

const {
  rebuildCompressedCatalog,
  getCompressionSummary,
  getBranchMappingPreview,
  getCompressedItemsForMetaSync,
} = require('./compressionEngine');

const {
  generateSkuSignature,
  generateMasterProductSignature,
} = require('./skuSignature');

module.exports = {
  // Engine operations
  rebuildCompressedCatalog,
  getCompressionSummary,
  getBranchMappingPreview,
  getCompressedItemsForMetaSync,

  // Signature utilities
  generateSkuSignature,
  generateMasterProductSignature,
};
