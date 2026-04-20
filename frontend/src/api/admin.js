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

// GET /api/admin/restaurants/:id/staff-pin/status — { set, updated_at, slug }.
export async function getRestaurantStaffPinStatus(id) {
  const { data } = await client.get(`/api/admin/restaurants/${id}/staff-pin/status`);
  return data;
}

// POST /api/admin/restaurants/:id/staff-pin/generate — returns freshly
// generated 4-digit PIN { pin, slug }. PIN is shown ONCE; backend stores a hash.
export async function generateRestaurantStaffPin(id) {
  const { data } = await client.post(`/api/admin/restaurants/${id}/staff-pin/generate`);
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

// ─── Applications (admin.html:2237-2366) ────────────────────────────────
// GET /api/admin/applications — all restaurant applications incl. non-pending.
export async function getApplications() {
  const { data } = await client.get('/api/admin/applications');
  return data;
}

// PATCH /api/admin/applications/:id/verify-gst — body: { verified: true|false }.
export async function verifyApplicationGst(id, verified = true) {
  const { data } = await client.patch(`/api/admin/applications/${id}/verify-gst`, { verified });
  return data;
}

// PATCH /api/admin/applications/:id/verify-fssai — body: { verified: true|false }.
export async function verifyApplicationFssai(id, verified = true) {
  const { data } = await client.patch(`/api/admin/applications/${id}/verify-fssai`, { verified });
  return data;
}

// PATCH /api/admin/applications/:id/approve — body: { notes }.
export async function approveApplication(id, notes = '') {
  const { data } = await client.patch(`/api/admin/applications/${id}/approve`, { notes });
  return data;
}

// PATCH /api/admin/applications/:id/reject — body: { notes } (reason required).
export async function rejectApplication(id, notes) {
  const { data } = await client.patch(`/api/admin/applications/${id}/reject`, { notes });
  return data;
}

// ─── Directory (admin.html:2549-2592) ───────────────────────────────────
// GET /api/admin/directory/stats — { total, active, total_views, total_orders }.
export async function getDirectoryStats() {
  const { data } = await client.get('/api/admin/directory/stats');
  return data;
}

// GET /api/admin/directory/listings — { listings: [...] }.
export async function getDirectoryListings(params = { limit: 100 }) {
  const { data } = await client.get('/api/admin/directory/listings', { params });
  return data;
}

// PATCH /api/admin/directory/listings/:id/toggle — body: { isActive }.
export async function toggleDirectoryListing(id, isActive) {
  const { data } = await client.patch(`/api/admin/directory/listings/${id}/toggle`, { isActive });
  return data;
}

// POST /api/admin/directory/sync-all — re-sync all approved restaurants.
export async function syncAllDirectory() {
  const { data } = await client.post('/api/admin/directory/sync-all');
  return data;
}

// ─── Orders (admin.html:2810-2846) ──────────────────────────────────────
// GET /api/admin/orders — params: limit, offset, status, date_from, date_to.
export async function getAdminOrders(params = {}) {
  const { data } = await client.get('/api/admin/orders', { params });
  return data;
}

// ─── Customers (admin.html:2865-2961) ───────────────────────────────────
// GET /api/admin/customers — params: limit, offset, search. Returns array.
export async function getAdminCustomers(params = {}) {
  const { data } = await client.get('/api/admin/customers', { params });
  return data;
}

// GET /api/admin/customers/identity — cross-restaurant metrics.
// Params: restaurant_id, customer_type, min_orders, sort, limit. Returns { items }.
export async function getAdminCustomerIdentity(params = {}) {
  const { data } = await client.get('/api/admin/customers/identity', { params });
  return data;
}

// ─── Issues (admin.html:4067-4300) ──────────────────────────────────────
// GET /api/admin/issues/stats?admin_queue=true — { open, in_progress, escalated, sla_breached, resolved, total }.
export async function getAdminIssueStats(params = { admin_queue: 'true' }) {
  const { data } = await client.get('/api/admin/issues/stats', { params });
  return data;
}

// GET /api/admin/issues — params: page, limit, admin_queue|status, category, priority, search.
// Returns { issues, page, pages, total }.
export async function getAdminIssues(params = {}) {
  const { data } = await client.get('/api/admin/issues', { params });
  return data;
}

// GET /api/admin/issues/:id — full issue with messages, _payment, _delivery, _order.
export async function getAdminIssue(id) {
  const { data } = await client.get(`/api/admin/issues/${id}`);
  return data;
}

// PUT /api/admin/issues/:id/status — body: { status }.
export async function setAdminIssueStatus(id, status) {
  const { data } = await client.put(`/api/admin/issues/${id}/status`, { status });
  return data;
}

// POST /api/admin/issues/:id/reopen — no body.
export async function reopenAdminIssue(id) {
  const { data } = await client.post(`/api/admin/issues/${id}/reopen`, {});
  return data;
}

// POST /api/admin/issues/:id/message — body: { text, internal }.
export async function postAdminIssueMessage(id, body) {
  const { data } = await client.post(`/api/admin/issues/${id}/message`, body);
  return data;
}

// POST /api/admin/issues/:id/resolve — body: { resolution_type, resolution_notes }.
export async function resolveAdminIssue(id, body) {
  const { data } = await client.post(`/api/admin/issues/${id}/resolve`, body);
  return data;
}

// POST /api/admin/issues/:id/refund — body: { amount_rs? }.
export async function refundAdminIssue(id, amountRs) {
  const body = amountRs ? { amount_rs: amountRs } : {};
  const { data } = await client.post(`/api/admin/issues/${id}/refund`, body);
  return data;
}

// POST /api/admin/issues/:id/flag-settlement — body: { deduct_from, amount_rs }.
export async function flagIssueSettlement(id, body) {
  const { data } = await client.post(`/api/admin/issues/${id}/flag-settlement`, body);
  return data;
}

// ─── Referrals (admin.html:3203-3310) ───────────────────────────────────
// GET /api/admin/referrals/stats — { total, active, converted, total_referral_fee_rs }.
export async function getReferralStats() {
  const { data } = await client.get('/api/admin/referrals/stats');
  return data;
}

// GET /api/admin/referrals — array of referrals.
export async function getReferrals() {
  const { data } = await client.get('/api/admin/referrals');
  return data;
}

// POST /api/admin/referrals — body: { restaurantId, customerWaPhone, customerName, notes }.
export async function createReferral(body) {
  const { data } = await client.post('/api/admin/referrals', body);
  return data;
}

// ─── Settlements (admin.html:2967-3125) ─────────────────────────────────
// GET /api/admin/settlements/stats.
export async function getSettlementStats() {
  const { data } = await client.get('/api/admin/settlements/stats');
  return data;
}

// GET /api/admin/settlements — params: limit, offset, status?, restaurant_id?, from?, to?.
export async function getSettlements(params = {}) {
  const { data } = await client.get('/api/admin/settlements', { params });
  return data;
}

// GET /api/admin/settlements/:id/meta-breakdown.
export async function getSettlementMetaBreakdown(id) {
  const { data } = await client.get(`/api/admin/settlements/${id}/meta-breakdown`);
  return data;
}

// GET /api/admin/settlements/:id/download — returns Excel blob (Axios responseType=blob).
export async function downloadSettlementBlob(id) {
  const res = await client.get(`/api/admin/settlements/${id}/download`, { responseType: 'blob' });
  return { blob: res.data, headers: res.headers };
}

// POST /api/admin/run-settlement — manual trigger for the scheduled settlement run.
export async function runSettlement() {
  const { data } = await client.post('/api/admin/run-settlement');
  return data;
}

// ─── Financials (admin.html:4310-4549) ──────────────────────────────────
// GET /api/admin/financials/overview?period=7d|30d|90d|this_fy.
export async function getFinancialsOverview(period = '30d') {
  const { data } = await client.get('/api/admin/financials/overview', { params: { period } });
  return data;
}

// GET /api/admin/financials/settlements?period&page&limit&restaurant_id?&status?.
export async function getFinancialsSettlements(params = {}) {
  const { data } = await client.get('/api/admin/financials/settlements', { params });
  return data;
}

// GET /api/admin/financials/settlements/:id.
export async function getFinancialsSettlement(id) {
  const { data } = await client.get(`/api/admin/financials/settlements/${id}`);
  return data;
}

// POST /api/admin/financials/settlements/:id/pay.
export async function payFinancialsSettlement(id) {
  const { data } = await client.post(`/api/admin/financials/settlements/${id}/pay`);
  return data;
}

// GET /api/admin/financials/payments?page&limit.
export async function getFinancialsPayments(params = { page: 1, limit: 20 }) {
  const { data } = await client.get('/api/admin/financials/payments', { params });
  return data;
}

// GET /api/admin/financials/refunds?page&limit.
export async function getFinancialsRefunds(params = { page: 1, limit: 20 }) {
  const { data } = await client.get('/api/admin/financials/refunds', { params });
  return data;
}

// GET /api/admin/financials/tax?period.
export async function getFinancialsTax(period = '30d') {
  const { data } = await client.get('/api/admin/financials/tax', { params: { period } });
  return data;
}

// GET /api/admin/financials/tax/tds-report?period — CSV blob download.
export async function downloadTdsReportBlob(period = '30d') {
  const res = await client.get('/api/admin/financials/tax/tds-report', {
    params: { period },
    responseType: 'blob',
  });
  return { blob: res.data, headers: res.headers };
}

// GET /api/admin/financials/tax/gstr1?period — CSV blob download.
export async function downloadGstr1Blob(period = '30d') {
  const res = await client.get('/api/admin/financials/tax/gstr1', {
    params: { period },
    responseType: 'blob',
  });
  return { blob: res.data, headers: res.headers };
}

// ─── Coupon templates (admin.html:5429-5527) ───────────────────────────
// GET /api/admin/coupon-templates?restaurant_id — { items: [{ name, status, language, components }] }.
export async function getCouponTemplates(restaurantId) {
  const { data } = await client.get('/api/admin/coupon-templates', {
    params: { restaurant_id: restaurantId },
  });
  return data;
}

// POST /api/admin/coupon-templates — body: { restaurant_id, name, header_text?, body_text, example_code }.
export async function createCouponTemplate(body) {
  const { data } = await client.post('/api/admin/coupon-templates', body);
  return data;
}

// ─── Coupon codes (admin.html:5536-5643) ───────────────────────────────
// GET /api/admin/coupons?restaurant_id — { items: [...] }.
export async function getAdminCoupons(restaurantId) {
  const { data } = await client.get('/api/admin/coupons', {
    params: { restaurant_id: restaurantId },
  });
  return data;
}

// POST /api/admin/coupons — create a coupon code.
export async function createAdminCoupon(body) {
  const { data } = await client.post('/api/admin/coupons', body);
  return data;
}

// PATCH /api/admin/coupons/:id — body: { is_active }.
export async function patchAdminCoupon(id, body) {
  const { data } = await client.patch(`/api/admin/coupons/${id}`, body);
  return data;
}

// ─── Marketing messages (admin.html:5259-5304) ─────────────────────────
// GET /api/admin/marketing-messages?page&limit&restaurant_id?&from?&to?.
export async function getAdminMarketingMessages(params = {}) {
  const { data } = await client.get('/api/admin/marketing-messages', { params });
  return data;
}

// ─── Analytics (admin.html:5004-5236) ──────────────────────────────────
// GET /api/admin/analytics/filters/cities → string[].
export async function getAnalyticsCities() {
  const { data } = await client.get('/api/admin/analytics/filters/cities');
  return data;
}

// GET /api/admin/analytics/filters/areas?city → string[].
export async function getAnalyticsAreas(city) {
  const { data } = await client.get('/api/admin/analytics/filters/areas', {
    params: { city },
  });
  return data;
}

// GET /api/admin/analytics/overview?from&to&city?&area?.
export async function getAnalyticsOverview(params = {}) {
  const { data } = await client.get('/api/admin/analytics/overview', { params });
  return data;
}

// GET /api/admin/analytics/orders/timeseries?from&to&city?&area?.
export async function getAnalyticsTimeseries(params = {}) {
  const { data } = await client.get('/api/admin/analytics/orders/timeseries', { params });
  return data;
}

// GET /api/admin/analytics/orders/by-status.
export async function getAnalyticsByStatus(params = {}) {
  const { data } = await client.get('/api/admin/analytics/orders/by-status', { params });
  return data;
}

// GET /api/admin/analytics/orders/by-hour.
export async function getAnalyticsByHour(params = {}) {
  const { data } = await client.get('/api/admin/analytics/orders/by-hour', { params });
  return data;
}

// GET /api/admin/analytics/orders/by-day.
export async function getAnalyticsByDay(params = {}) {
  const { data } = await client.get('/api/admin/analytics/orders/by-day', { params });
  return data;
}

// GET /api/admin/analytics/geographic/cities.
export async function getAnalyticsGeographicCities(params = {}) {
  const { data } = await client.get('/api/admin/analytics/geographic/cities', { params });
  return data;
}

// GET /api/admin/analytics/restaurants/ranking.
export async function getAnalyticsRestaurantRanking(params = {}) {
  const { data } = await client.get('/api/admin/analytics/restaurants/ranking', { params });
  return data;
}

// GET /api/admin/analytics/customers/segments (no query).
export async function getAnalyticsCustomerSegments() {
  const { data } = await client.get('/api/admin/analytics/customers/segments');
  return data;
}

// GET /api/admin/analytics/delivery/performance.
export async function getAnalyticsDeliveryPerformance(params = {}) {
  const { data } = await client.get('/api/admin/analytics/delivery/performance', { params });
  return data;
}

// GET /api/admin/analytics/customers/overview.
export async function getAnalyticsCustomersOverview(params = {}) {
  const { data } = await client.get('/api/admin/analytics/customers/overview', { params });
  return data;
}

// GET /api/admin/analytics/funnel (optionally ?group_by=restaurant).
export async function getAnalyticsFunnel(params = {}) {
  const { data } = await client.get('/api/admin/analytics/funnel', { params });
  return data;
}

// ─── Webhook logs (admin.html:2373-2455) ────────────────────────────────
// GET /api/admin/logs — params: limit, offset, source, processed, has_error, event_type, date_from, date_to.
export async function getAdminLogs(params = {}) {
  const { data } = await client.get('/api/admin/logs', { params });
  return data;
}

// GET /api/admin/logs/:id — full log detail with JSON payload.
export async function getAdminLog(id) {
  const { data } = await client.get(`/api/admin/logs/${id}`);
  return data;
}

// ─── Dead letter queue (admin.html:2461-2546) ──────────────────────────
// GET /api/admin/webhook-retry/stats.
export async function getDlqStats() {
  const { data } = await client.get('/api/admin/webhook-retry/stats');
  return data;
}

// GET /api/admin/dlq — params: limit, offset, source.
export async function getDlq(params = {}) {
  const { data } = await client.get('/api/admin/dlq', { params });
  return data;
}

// POST /api/admin/dlq/:id/retry.
export async function retryDlq(id) {
  const { data } = await client.post(`/api/admin/dlq/${id}/retry`);
  return data;
}

// POST /api/admin/dlq/:id/dismiss.
export async function dismissDlq(id) {
  const { data } = await client.post(`/api/admin/dlq/${id}/dismiss`);
  return data;
}

// ─── Catalog sync logs + Meta alerts (admin.html:5303-5424) ────────────
// GET /api/admin/sync-logs — params: restaurant_id, status, reason, from, to, limit.
export async function getSyncLogs(params = {}) {
  const { data } = await client.get('/api/admin/sync-logs', { params });
  return data;
}

// GET /api/admin/meta-alerts — params: status, type, limit.
export async function getMetaAlerts(params = {}) {
  const { data } = await client.get('/api/admin/meta-alerts', { params });
  return data;
}

// POST /api/admin/meta-alerts/:id/resolve.
export async function resolveMetaAlert(id) {
  const { data } = await client.post(`/api/admin/meta-alerts/${id}/resolve`);
  return data;
}

// ─── Activity monitor (admin.html:3731-4063) ───────────────────────────
// GET /api/admin/activity/stats.
export async function getActivityStats() {
  const { data } = await client.get('/api/admin/activity/stats');
  return data;
}

// GET /api/admin/activity — params: page, limit, category, severity, restaurant_id, search.
export async function getActivityFeed(params = {}) {
  const { data } = await client.get('/api/admin/activity', { params });
  return data;
}

// GET /api/admin/webhooks/live — params: page, limit.
export async function getWebhooksLive(params = {}) {
  const { data } = await client.get('/api/admin/webhooks/live', { params });
  return data;
}

// GET /api/admin/webhooks/:id — full webhook payload.
export async function getWebhookDetail(id) {
  const { data } = await client.get(`/api/admin/webhooks/${id}`);
  return data;
}

// GET /api/admin/activity/errors — params: page, limit.
export async function getActivityErrors(params = {}) {
  const { data } = await client.get('/api/admin/activity/errors', { params });
  return data;
}

// PUT /api/admin/activity/:id/resolve.
export async function resolveActivity(id) {
  const { data } = await client.put(`/api/admin/activity/${id}/resolve`);
  return data;
}

// GET /api/admin/activity/restaurant/:id — params: page, limit, category.
export async function getActivityForRestaurant(id, params = {}) {
  const { data } = await client.get(`/api/admin/activity/restaurant/${id}`, { params });
  return data;
}

// ─── Abuse protection (admin.html:2595-2728) ───────────────────────────
// GET /api/admin/rate-limit/stats.
export async function getRateLimitStats() {
  const { data } = await client.get('/api/admin/rate-limit/stats');
  return data;
}

// GET /api/admin/blocked-phones.
export async function getBlockedPhones() {
  const { data } = await client.get('/api/admin/blocked-phones');
  return data;
}

// POST /api/admin/blocked-phones — body: { wa_phone, reason, durationHours }.
export async function blockPhone(body) {
  const { data } = await client.post('/api/admin/blocked-phones', body);
  return data;
}

// DELETE /api/admin/blocked-phones/:id.
export async function unblockPhone(id) {
  const { data } = await client.delete(`/api/admin/blocked-phones/${id}`);
  return data;
}

// ─── Admin users (admin.html:2651-2693) ────────────────────────────────
// GET /api/admin/users — super-admin-only.
export async function getAdminUsers() {
  const { data } = await client.get('/api/admin/users');
  return data;
}

// PUT /api/admin/users/:id — body: { customer_full_phone: boolean }.
export async function updateAdminUser(id, body) {
  const { data } = await client.put(`/api/admin/users/${id}`, body);
  return data;
}

// ─── Usernames (admin.html:3533-3729) ──────────────────────────────────
// GET /api/admin/usernames — params: search, status.
export async function getUsernames(params = {}) {
  const { data } = await client.get('/api/admin/usernames', { params });
  return data;
}

// POST /api/admin/usernames/:waid/check — body: { username }.
export async function checkUsername(waid, username) {
  const { data } = await client.post(`/api/admin/usernames/${waid}/check`, { username });
  return data;
}

// POST /api/admin/usernames/:waid/set-target — body: { username }.
export async function setUsernameTarget(waid, username) {
  const { data } = await client.post(`/api/admin/usernames/${waid}/set-target`, { username });
  return data;
}

// POST /api/admin/usernames/:waid/confirm — body: { username }.
export async function confirmUsername(waid, username) {
  const { data } = await client.post(`/api/admin/usernames/${waid}/confirm`, { username });
  return data;
}

// POST /api/admin/usernames/:waid/sync.
export async function syncUsername(waid) {
  const { data } = await client.post(`/api/admin/usernames/${waid}/sync`);
  return data;
}

// POST /api/admin/usernames/:waid/release.
export async function releaseUsername(waid) {
  const { data } = await client.post(`/api/admin/usernames/${waid}/release`);
  return data;
}

// POST /api/admin/usernames/:waid/suggest.
export async function suggestUsernames(waid) {
  const { data } = await client.post(`/api/admin/usernames/${waid}/suggest`);
  return data;
}

// POST /api/admin/usernames/auto-suggest.
export async function autoSuggestUsernamesAll() {
  const { data } = await client.post('/api/admin/usernames/auto-suggest');
  return data;
}

// POST /api/admin/usernames/sync-all.
export async function syncUsernamesAll() {
  const { data } = await client.post('/api/admin/usernames/sync-all');
  return data;
}

// ─── Logistics analytics (admin.html:5739-5840) ────────────────────────
// GET /api/admin/logistics/analytics — params: from, to, restaurantId, branchId, lsp.
export async function getLogisticsAnalytics(params = {}) {
  const { data } = await client.get('/api/admin/logistics/analytics', { params });
  return data;
}

// GET /api/admin/branches?restaurant_id=... — for Logistics branch filter cascade.
export async function getAdminBranches(restaurantId) {
  const { data } = await client.get('/api/admin/branches', {
    params: { restaurant_id: restaurantId },
  });
  return data;
}

// ─── Overview (admin.html:2094-2185) ────────────────────────────────────
// GET /api/admin/stats — platform aggregate stats driving the 6 main cards.
export async function getAdminStats() {
  const { data } = await client.get('/api/admin/stats');
  return data;
}

// GET /api/admin/ratings/stats — avg rating + total reviews.
export async function getAdminRatingStats() {
  const { data } = await client.get('/api/admin/ratings/stats');
  return data;
}

// GET /api/admin/delivery/stats — today's delivery counters + avg/cost.
export async function getAdminDeliveryStats() {
  const { data } = await client.get('/api/admin/delivery/stats');
  return data;
}

// GET /api/admin/alerts — platform-wide alert banner list.
export async function getAdminAlerts() {
  const { data } = await client.get('/api/admin/alerts');
  return data;
}
