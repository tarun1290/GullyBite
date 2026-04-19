import client from './client.js';

// Admin-only endpoints. Mirrors the legacy handlers invoked from
// /frontend/admin.html, /frontend/js/flow-editor.js and
// /frontend/js/template-editor.js. Separate from restaurant.js because
// these require the admin role — ProtectedRoute enforces that on the
// matching routes, and the shared Axios client auto-attaches zm_token.

// ─── Flows ──────────────────────────────────────────────────────────────
// GET /api/admin/flows — library list (admin.html:4790).
export async function getFlows() {
  const { data } = await client.get('/api/admin/flows');
  return data;
}

// GET /api/admin/flows/:id/json — canonical flow JSON (flow-editor.js:127).
export async function getFlowJson(id) {
  const { data } = await client.get(`/api/admin/flows/${id}/json`);
  return data;
}

// PUT /api/admin/flows/:id — save flow JSON (flow-editor.js:819).
export async function updateFlow(id, body) {
  const { data } = await client.put(`/api/admin/flows/${id}`, body);
  return data;
}

// POST /api/admin/flows/:id/publish (flow-editor.js:830, admin.html:4828).
export async function publishFlow(id) {
  const { data } = await client.post(`/api/admin/flows/${id}/publish`);
  return data;
}

// POST /api/admin/flows/:id/deprecate (admin.html:4833).
export async function deprecateFlow(id) {
  const { data } = await client.post(`/api/admin/flows/${id}/deprecate`);
  return data;
}

// DELETE /api/admin/flows/:id (admin.html:4838).
export async function deleteFlow(id) {
  const { data } = await client.delete(`/api/admin/flows/${id}`);
  return data;
}

// GET /api/admin/flows/assignments — { ordering_flow_id, support_flow_id, ... }
// (admin.html:4815).
export async function getFlowAssignments() {
  const { data } = await client.get('/api/admin/flows/assignments');
  return data;
}

// PUT /api/admin/flows/assignments — body: { type, flow_id, flow_name }
// (admin.html:4843). `type` is 'ordering' | 'support' | etc.
export async function assignFlowAs(type, flowId, flowName) {
  const { data } = await client.put('/api/admin/flows/assignments', {
    type,
    flow_id: flowId,
    flow_name: flowName,
  });
  return data;
}

// GET /api/admin/flows/templates — starter templates for "Create from template"
// (admin.html:4849).
export async function getFlowTemplates() {
  const { data } = await client.get('/api/admin/flows/templates');
  return data;
}

// POST /api/admin/flows — body varies by creation mode (admin.html:4879).
export async function createFlow(body) {
  const { data } = await client.post('/api/admin/flows', body);
  return data;
}

// ─── Templates ──────────────────────────────────────────────────────────
// GET /api/admin/templates — WABA templates list (template-editor.js:59).
export async function getTemplates(params = {}) {
  const { data } = await client.get('/api/admin/templates', { params });
  return data;
}

// GET /api/admin/templates/gallery — local gallery (template-editor.js:81).
export async function getTemplateGallery() {
  const { data } = await client.get('/api/admin/templates/gallery');
  return data;
}

// POST /api/admin/templates — create/submit template (template-editor.js:410).
export async function createTemplate(payload) {
  const { data } = await client.post('/api/admin/templates', payload);
  return data;
}

// DELETE /api/admin/templates — body: { name, waba_id? }
// (template-editor.js:419, admin.html:3454). Axios needs body under `data:`.
export async function deleteTemplate(body) {
  const payload = typeof body === 'string' ? { name: body } : body;
  const { data } = await client.delete('/api/admin/templates', { data: payload });
  return data;
}

// GET /api/admin/templates/mappings — event → template bindings (admin.html:3331).
export async function getTemplateMappings() {
  const { data } = await client.get('/api/admin/templates/mappings');
  return data;
}

// PUT /api/admin/templates/mappings/:event — body: { template_name }
// (admin.html:3502).
export async function setTemplateMapping(event, body) {
  const { data } = await client.put(`/api/admin/templates/mappings/${event}`, body);
  return data;
}

// GET /api/admin/templates/notifications?limit=N — recent send-log
// (admin.html:3366).
export async function getTemplateNotifications(limit = 30) {
  const { data } = await client.get('/api/admin/templates/notifications', {
    params: { limit },
  });
  return data;
}

// POST /api/admin/templates/sync — body: { waba_id } (admin.html:3384).
export async function syncTemplates(wabaId) {
  const { data } = await client.post('/api/admin/templates/sync', { waba_id: wabaId });
  return data;
}

// POST /api/admin/templates/seed — seed built-in templates (admin.html:3392).
export async function seedTemplates() {
  const { data } = await client.post('/api/admin/templates/seed');
  return data;
}

// POST /api/admin/templates/test-send — body: { template_name, phone, variables }
// (admin.html:3521).
export async function testSendTemplate(body) {
  const { data } = await client.post('/api/admin/templates/test-send', body);
  return data;
}

// ─── Restaurants ────────────────────────────────────────────────────────
// GET /api/admin/restaurants — directory rows with orders/revenue/status
// (admin.html:2735).
export async function getAdminRestaurants() {
  const { data } = await client.get('/api/admin/restaurants');
  return data;
}

// PATCH /api/admin/restaurants/:id — body: { status } (admin.html:2786).
export async function updateAdminRestaurant(id, body) {
  const { data } = await client.patch(`/api/admin/restaurants/${id}`, body);
  return data;
}

// PATCH /api/admin/restaurants/:id/campaign-cap — body: { campaign_daily_cap }
// (admin.html:2777). Pass null to clear the cap.
export async function setRestaurantCampaignCap(id, cap) {
  const { data } = await client.patch(
    `/api/admin/restaurants/${id}/campaign-cap`,
    { campaign_daily_cap: cap }
  );
  return data;
}

// DELETE /api/admin/restaurants/:id (admin.html:2799).
export async function deleteAdminRestaurant(id) {
  const { data } = await client.delete(`/api/admin/restaurants/${id}`);
  return data;
}

// ─── Pincode serviceability (Prorouting) ────────────────────────────────
// Platform-wide pincode map. Not per-restaurant.

// GET /api/admin/pincodes — paginated list with search/status filters.
export async function getPincodes(params = {}) {
  const { data } = await client.get('/api/admin/pincodes', { params });
  return data;
}

// GET /api/admin/pincodes/stats — { total, enabled, disabled }.
export async function getPincodeStats() {
  const { data } = await client.get('/api/admin/pincodes/stats');
  return data;
}

// PUT /api/admin/pincodes/:pincode/toggle — flip the enabled flag.
export async function togglePincode(pincode) {
  const { data } = await client.put(`/api/admin/pincodes/${encodeURIComponent(pincode)}/toggle`);
  return data;
}

// PUT /api/admin/pincodes/bulk — enable/disable many at once. Accepts
// either an explicit `pincodes` array OR a `filter` { search, status }.
export async function bulkUpdatePincodes(body) {
  const { data } = await client.put('/api/admin/pincodes/bulk', body);
  return data;
}

// POST /api/admin/pincodes/import — upsert-on-insert; never overrides
// existing `enabled` values. Used by the CSV importer.
export async function importPincodes(body) {
  const { data } = await client.post('/api/admin/pincodes/import', body);
  return data;
}

// GET /api/admin/pincodes/cities — aggregated { state, city, total, enabled, disabled }
// rows for the grouped admin view.
export async function getPincodeCities() {
  const { data } = await client.get('/api/admin/pincodes/cities');
  return data;
}

// PUT /api/admin/pincodes/bulk-by-city — body: { city, state, enabled }.
export async function bulkUpdateByCity(body) {
  const { data } = await client.put('/api/admin/pincodes/bulk-by-city', body);
  return data;
}
