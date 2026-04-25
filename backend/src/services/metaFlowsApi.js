'use strict';

// Thin client for the Meta WhatsApp Flows API. Four operations:
//
//   createFlow(wabaId, { name, categories })
//     POSTs to /{waba-id}/flows to create a new (DRAFT) Flow container.
//     Returns the raw Meta response (`{ id }` on success).
//
//   uploadFlowAsset(flowId, jsonContent)
//     POSTs JSON content to /{flow-id}/assets as a FLOW_JSON multipart upload.
//     Returns the raw Meta response so the caller can inspect
//     validation_errors before publishing.
//
//   publishFlow(flowId)
//     POSTs to /{flow-id}/publish to promote the latest uploaded asset to
//     the live version.
//
//   deleteFlow(flowId)
//     DELETEs /{flow-id}. Hard-deletes the Flow on Meta. Subsequent sends
//     referencing this flow_id will fail — make sure DB references are
//     repointed before customer traffic resumes.
//
// Why not reuse flowManager.updateFlowJson? That helper bundles JSON-build
// + upload + endpoint_uri tweak. The endpoint_uri write is correct for
// initial-create flows but wrong for republish of a no-endpoint flow.
// Keeping this client concern-free lets scripts/publishDeliveryAddressFlow.js
// re-publish without flipping endpoint mode.
//
// Auth: META_SYSTEM_USER_TOKEN via metaConfig.getMessagingToken()
// (NEVER WA_CATALOG_TOKEN — that env was retired).

const axios = require('axios');
const FormData = require('form-data');
const metaConfig = require('../config/meta');

async function createFlow(wabaId, { name, categories } = {}) {
  if (!wabaId) throw new Error('createFlow: wabaId required');
  if (!name) throw new Error('createFlow: name required');
  if (!Array.isArray(categories) || !categories.length) {
    throw new Error('createFlow: categories required (non-empty array)');
  }

  const token = metaConfig.getMessagingToken();
  if (!token) throw new Error('createFlow: META_SYSTEM_USER_TOKEN is not set');

  const { data } = await axios.post(
    `${metaConfig.graphUrl}/${wabaId}/flows`,
    { name, categories },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return data;
}

async function deleteFlow(flowId) {
  if (!flowId) throw new Error('deleteFlow: flowId required');

  const token = metaConfig.getMessagingToken();
  if (!token) throw new Error('deleteFlow: META_SYSTEM_USER_TOKEN is not set');

  const { data } = await axios.delete(
    `${metaConfig.graphUrl}/${flowId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    }
  );
  return data;
}

async function uploadFlowAsset(flowId, jsonContent) {
  if (!flowId) throw new Error('uploadFlowAsset: flowId required');
  if (jsonContent == null) throw new Error('uploadFlowAsset: jsonContent required');

  const token = metaConfig.getMessagingToken();
  if (!token) throw new Error('uploadFlowAsset: META_SYSTEM_USER_TOKEN is not set');

  const buf = Buffer.from(
    typeof jsonContent === 'string' ? jsonContent : JSON.stringify(jsonContent)
  );

  const form = new FormData();
  form.append('file', buf, { filename: 'flow.json', contentType: 'application/json' });
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');

  const { data } = await axios.post(
    `${metaConfig.graphUrl}/${flowId}/assets`,
    form,
    {
      headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
      timeout: 20000,
    }
  );
  return data;
}

async function publishFlow(flowId) {
  if (!flowId) throw new Error('publishFlow: flowId required');

  const token = metaConfig.getMessagingToken();
  if (!token) throw new Error('publishFlow: META_SYSTEM_USER_TOKEN is not set');

  const { data } = await axios.post(
    `${metaConfig.graphUrl}/${flowId}/publish`,
    {},
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    }
  );
  return data;
}

module.exports = { createFlow, deleteFlow, uploadFlowAsset, publishFlow };
