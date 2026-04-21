import client from './client.js';
import authClient from './authClient.js';

// GET /api/restaurant — canonical profile. Served by backend/src/routes/restaurant.js:246.
export async function getRestaurantProfile() {
  const { data } = await client.get('/api/restaurant');
  return data;
}

// GET /api/restaurant/analytics?days=N — returns { summary: { total_orders, total_revenue, ... } }
export async function getAnalyticsSummary(days = 1) {
  const { data } = await client.get('/api/restaurant/analytics', { params: { days } });
  return data;
}

// GET /api/restaurant/orders?limit=N — recent orders list (Overview recent table, first N)
export async function getRestaurantOrders(params = {}) {
  const { data } = await client.get('/api/restaurant/orders', { params });
  return data;
}

// GET /api/restaurant/orders — Orders-tab list. Legacy calls with limit=60 and an optional status filter.
export async function getOrders(params = {}) {
  const { data } = await client.get('/api/restaurant/orders', { params });
  return data;
}

// GET /api/restaurant/orders/:id — single order detail
export async function getOrderById(id) {
  const { data } = await client.get(`/api/restaurant/orders/${id}`);
  return data;
}

// PATCH /api/restaurant/orders/:id/status — body: { status }
export async function updateOrderStatus(id, status) {
  const { data } = await client.patch(`/api/restaurant/orders/${id}/status`, { status });
  return data;
}

// POST /api/restaurant/orders/:id/dispatch — dispatch to 3PL (no payload required by legacy)
export async function dispatchOrder(id, payload = {}) {
  const { data } = await client.post(`/api/restaurant/orders/${id}/dispatch`, payload);
  return data;
}

// POST /api/restaurant/orders/:id/cancel-delivery — cancel an in-flight dispatch
export async function cancelDelivery(id) {
  const { data } = await client.post(`/api/restaurant/orders/${id}/cancel-delivery`);
  return data;
}

// GET /api/restaurant/orders/:id/delivery — returns { delivery: {...} } when present
export async function getDeliveryStatus(id) {
  const { data } = await client.get(`/api/restaurant/orders/${id}/delivery`);
  return data;
}

// GET /api/restaurant/branches — array, drives wizard "Add first branch" step
export async function getBranches() {
  const { data } = await client.get('/api/restaurant/branches');
  return data;
}

// GET /api/restaurant/menu/all — { total_count, ... } — drives wizard "Add menu items" step
export async function getMenuAll() {
  const { data } = await client.get('/api/restaurant/menu/all');
  return data;
}

// GET /api/restaurant/messaging-status — { messaging_limit_tier, business_verification_status }
// Legacy overview.js does NOT call this; it's only used on Settings. Exposed here for
// reuse by later tabs and to satisfy the Phase 2d spec's api surface requirement.
export async function getMessagingStatus() {
  const { data } = await client.get('/api/restaurant/messaging-status');
  return data;
}

// ── Messages tab ─────────────────────────────────────────────────────
// GET /api/restaurant/messages?status=&search= → { threads: [...] }
// Mirrors fetchThreads() in legacy messages.js:17.
export async function getMessages(params = {}) {
  const { data } = await client.get('/api/restaurant/messages', { params });
  return data;
}

// GET /api/restaurant/messages/thread/:customerId → { messages: [...] }
// Mirrors loadMsgThread() in messages.js:97.
export async function getThread(customerId) {
  const { data } = await client.get(`/api/restaurant/messages/thread/${customerId}`);
  return data;
}

// POST /api/restaurant/messages/reply — body { customer_id, text } (plain text, matches messages.js:167)
export async function replyToThread(customerId, payload) {
  const body = { customer_id: customerId, ...payload };
  const { data } = await client.post('/api/restaurant/messages/reply', body);
  return data;
}

// GET /api/restaurant/messages/unread-count → { count }
export async function getUnreadCount() {
  const { data } = await client.get('/api/restaurant/messages/unread-count');
  return data;
}

// PUT /api/restaurant/messages/thread/:customerId/resolve
export async function resolveThread(customerId) {
  const { data } = await client.put(`/api/restaurant/messages/thread/${customerId}/resolve`);
  return data;
}

// ── Issues tab ───────────────────────────────────────────────────────
// GET /api/restaurant/issues?page=&limit=&status=&category=&search=
// Mirrors loadIssueList() in messages.js:280.
export async function getIssues(params = {}) {
  const { data } = await client.get('/api/restaurant/issues', { params });
  return data;
}

// GET /api/restaurant/issues/:id → full issue incl. messages, media
export async function getIssueById(id) {
  const { data } = await client.get(`/api/restaurant/issues/${id}`);
  return data;
}

// POST /api/restaurant/issues/:id/message — body { text, internal }
export async function replyToIssue(id, payload) {
  const { data } = await client.post(`/api/restaurant/issues/${id}/message`, payload);
  return data;
}

// POST /api/restaurant/issues/:id/resolve — body { resolution_type, resolution_notes }
export async function resolveIssue(id, payload = {}) {
  const { data } = await client.post(`/api/restaurant/issues/${id}/resolve`, payload);
  return data;
}

// POST /api/restaurant/issues/:id/escalate — body { reason }
export async function escalateIssue(id, payload = {}) {
  const { data } = await client.post(`/api/restaurant/issues/${id}/escalate`, payload);
  return data;
}

// POST /api/restaurant/issues/:id/reopen
export async function reopenIssue(id) {
  const { data } = await client.post(`/api/restaurant/issues/${id}/reopen`, {});
  return data;
}

// ── Analytics tab ────────────────────────────────────────────────────
// All period-based endpoints accept { period: '7d' | '30d' | '90d' | 'all' }.
// Legacy calls in analytics.js:75-260.

// GET /api/restaurant/analytics/overview?period=
export async function getAnalyticsOverview(params = {}) {
  const { data } = await client.get('/api/restaurant/analytics/overview', { params });
  return data;
}

// GET /api/restaurant/analytics/revenue?period=&granularity=day|week|month
export async function getRevenueAnalytics(params = {}) {
  const { data } = await client.get('/api/restaurant/analytics/revenue', { params });
  return data;
}

// GET /api/restaurant/analytics/top-items?period=&limit=
export async function getTopItems(params = {}) {
  const { data } = await client.get('/api/restaurant/analytics/top-items', { params });
  return data;
}

// GET /api/restaurant/analytics/peak-hours?period= → { hours: [...], days: [...] }
export async function getPeakHours(params = {}) {
  const { data } = await client.get('/api/restaurant/analytics/peak-hours', { params });
  return data;
}

// GET /api/restaurant/analytics/customers?period=
export async function getCustomerAnalytics(params = {}) {
  const { data } = await client.get('/api/restaurant/analytics/customers', { params });
  return data;
}

// GET /api/restaurant/analytics/delivery?period=
export async function getDeliveryAnalytics(params = {}) {
  const { data } = await client.get('/api/restaurant/analytics/delivery', { params });
  return data;
}

// GET /api/restaurant/analytics/dropoffs?from=&to=&limit=
export async function getDropoffs(params = {}) {
  const { data } = await client.get('/api/restaurant/analytics/dropoffs', { params });
  return data;
}

// GET /api/restaurant/analytics/recovery-stats?from=&to=
export async function getRecoveryStats(params = {}) {
  const { data } = await client.get('/api/restaurant/analytics/recovery-stats', { params });
  return data;
}

// GET /api/restaurant/analytics/cart-recovery?period=
export async function getCartRecovery(params = {}) {
  const { data } = await client.get('/api/restaurant/analytics/cart-recovery', { params });
  return data;
}

// POST /api/restaurant/dropoffs/:convId/recover → { success }
export async function recoverDropoff(convId) {
  const { data } = await client.post(`/api/restaurant/dropoffs/${convId}/recover`);
  return data;
}

// ── Marketing tab ────────────────────────────────────────────────────

// GET /api/restaurant/campaigns — array of campaign rows
// Mirrors loadCampaigns() in legacy restaurant.js:574.
export async function getCampaigns() {
  const { data } = await client.get('/api/restaurant/campaigns');
  return data;
}

// POST /api/restaurant/campaigns — body { branchId, name, productIds[], segment, scheduleAt, headerText, bodyText, tags? }
export async function createCampaign(body) {
  const { data } = await client.post('/api/restaurant/campaigns', body);
  return data;
}

// POST /api/restaurant/campaigns/:id/send
export async function sendCampaign(id) {
  const { data } = await client.post(`/api/restaurant/campaigns/${id}/send`);
  return data;
}

// POST /api/restaurant/campaigns/:id/pause
export async function pauseCampaign(id) {
  const { data } = await client.post(`/api/restaurant/campaigns/${id}/pause`);
  return data;
}

// POST /api/restaurant/campaigns/:id/resume
export async function resumeCampaign(id) {
  const { data } = await client.post(`/api/restaurant/campaigns/${id}/resume`);
  return data;
}

// DELETE /api/restaurant/campaigns/:id
export async function deleteCampaign(id) {
  const { data } = await client.delete(`/api/restaurant/campaigns/${id}`);
  return data;
}

// GET /api/restaurant/campaigns/daily-usage → { sent_today, daily_cap, resets_at }
export async function getCampaignDailyUsage() {
  const { data } = await client.get('/api/restaurant/campaigns/daily-usage');
  return data;
}

// GET /api/restaurant/campaigns/analytics?from=&to= → { items: [...] }
export async function getCampaignAnalytics(params = {}) {
  const { data } = await client.get('/api/restaurant/campaigns/analytics', { params });
  return data;
}

// GET /api/restaurant/customers/tags → { tags: [...] }
export async function getCustomerTags() {
  const { data } = await client.get('/api/restaurant/customers/tags');
  return data;
}

// GET /api/restaurant/branches/:branchId/items → [{ id, name, variant_value, food_type, price_paise }]
export async function getBranchItems(branchId) {
  const { data } = await client.get(`/api/restaurant/branches/${branchId}/items`);
  return data;
}

// GET /api/restaurant/coupons — array of coupons
export async function getCoupons() {
  const { data } = await client.get('/api/restaurant/coupons');
  return data;
}

// POST /api/restaurant/coupons — body { code, description, discountType, discountValue, minOrderRs, maxDiscountRs, usageLimit, validFrom, validUntil }
export async function createCoupon(body) {
  const { data } = await client.post('/api/restaurant/coupons', body);
  return data;
}

// PATCH /api/restaurant/coupons/:id — body { isActive } (toggle)
export async function updateCoupon(id, body) {
  const { data } = await client.patch(`/api/restaurant/coupons/${id}`, body);
  return data;
}

// DELETE /api/restaurant/coupons/:id
export async function deleteCoupon(id) {
  const { data } = await client.delete(`/api/restaurant/coupons/${id}`);
  return data;
}

// GET /api/restaurant/referrals → { summary, referrals[] }
export async function getReferrals() {
  const { data } = await client.get('/api/restaurant/referrals');
  return data;
}

// GET /api/restaurant/marketing-messages?page=&limit=&from=&to= → { items, total, total_cost }
export async function getMarketingMessages(params = {}) {
  const { data } = await client.get('/api/restaurant/marketing-messages', { params });
  return data;
}

// ── Payments tab ─────────────────────────────────────────────────────
// Legacy `period` is one of 1d / 7d / 30d / last_month, and for custom
// ranges the legacy code concatenates `custom&from=YYYY-MM-DD&to=YYYY-MM-DD`
// into the querystring (see payments.js:30). We accept an object here so
// the caller builds params cleanly instead of leaking that string hack.

// GET /api/restaurant/financials/summary?period=&from=&to=
export async function getFinancialSummary(params = {}) {
  const { data } = await client.get('/api/restaurant/financials/summary', { params });
  return data;
}

// GET /api/restaurant/financials/daily?period=&from=&to= → { days: [...] }
export async function getDailyFinancials(params = {}) {
  const { data } = await client.get('/api/restaurant/financials/daily', { params });
  return data;
}

// GET /api/restaurant/financials/settlements?page=&limit= → { settlements, has_more, total_pages }
export async function getSettlements(params = {}) {
  const { data } = await client.get('/api/restaurant/financials/settlements', { params });
  return data;
}

// GET /api/restaurant/financials/settlements/:id — full detail incl. orders[]
export async function getSettlementById(id) {
  const { data } = await client.get(`/api/restaurant/financials/settlements/${id}`);
  return data;
}

// GET /api/restaurant/settlements/:id/meta-breakdown — Phase-5 Meta messaging deductions
export async function getSettlementMetaBreakdown(id) {
  const { data } = await client.get(`/api/restaurant/settlements/${id}/meta-breakdown`);
  return data;
}

// GET /api/restaurant/settlements/:id/download — returns a binary (xlsx) blob.
// We ask axios for a blob response so content-disposition is preserved and
// the caller can pull the filename off the header.
export async function downloadSettlement(id) {
  const resp = await client.get(`/api/restaurant/settlements/${id}/download`, {
    responseType: 'blob',
  });
  return resp;
}

// GET /api/restaurant/financials/payments?page=&limit=&from=&to=
export async function getPayments(params = {}) {
  const { data } = await client.get('/api/restaurant/financials/payments', { params });
  return data;
}

// GET /api/restaurant/financials/tax-summary
export async function getTaxSummary() {
  const { data } = await client.get('/api/restaurant/financials/tax-summary');
  return data;
}

// GET /api/restaurant/wallet → balance + status
export async function getWallet() {
  const { data } = await client.get('/api/restaurant/wallet');
  return data;
}

// GET /api/restaurant/settings/marketing-wa — current marketing WA config.
export async function getMarketingWaStatus() {
  const { data } = await client.get('/api/restaurant/settings/marketing-wa');
  return data;
}

// POST /api/restaurant/settings/marketing-wa — save phone_number_id + waba_id.
export async function saveMarketingWaNumber(payload) {
  const { data } = await client.post('/api/restaurant/settings/marketing-wa', payload);
  return data;
}

// GET /api/restaurant/customers/stats — headline tiles for Customers tab.
export async function getCustomerStats() {
  const { data } = await client.get('/api/restaurant/customers/stats');
  return data;
}

// GET /api/restaurant/customers/segments — RFM segment counts.
export async function getCustomerSegments() {
  const { data } = await client.get('/api/restaurant/customers/segments');
  return data;
}

// GET /api/restaurant/customers/by-segment/:label — top rows per segment.
export async function getCustomersBySegment(label, limit = 20) {
  const { data } = await client.get(
    `/api/restaurant/customers/by-segment/${encodeURIComponent(label)}`,
    { params: { limit } },
  );
  return data;
}

// GET /api/restaurant/campaign-templates?use_case= — approved + active only.
export async function getCampaignTemplates(params = {}) {
  const { data } = await client.get('/api/restaurant/campaign-templates', { params });
  return data;
}

// GET /api/restaurant/campaign-templates/:templateId
export async function getCampaignTemplate(templateId) {
  const { data } = await client.get(`/api/restaurant/campaign-templates/${encodeURIComponent(templateId)}`);
  return data;
}

// ── Marketing campaigns (manual blasts) ─────────────────────────────
// Distinct from legacy /campaigns (MPM catalog). Uses campaign_templates
// + customer_rfm_profiles to blast template messages to an RFM segment.

// POST /api/restaurant/marketing-campaigns/create
export async function createMarketingCampaign(body) {
  const { data } = await client.post('/api/restaurant/marketing-campaigns/create', body);
  return data;
}

// GET /api/restaurant/marketing-campaigns?page=&limit=&status=
export async function getMarketingCampaigns(params = {}) {
  const { data } = await client.get('/api/restaurant/marketing-campaigns', { params });
  return data;
}

// GET /api/restaurant/marketing-campaigns/:id
export async function getMarketingCampaign(id) {
  const { data } = await client.get(`/api/restaurant/marketing-campaigns/${encodeURIComponent(id)}`);
  return data;
}

// POST /api/restaurant/marketing-campaigns/:id/cancel
export async function cancelMarketingCampaign(id) {
  const { data } = await client.post(`/api/restaurant/marketing-campaigns/${encodeURIComponent(id)}/cancel`);
  return data;
}

// GET /api/restaurant/marketing-campaigns/stats/summary
export async function getMarketingCampaignSummary() {
  const { data } = await client.get('/api/restaurant/marketing-campaigns/stats/summary');
  return data;
}

// ── Auto journeys ───────────────────────────────────────────────────
// Per-restaurant toggle + customisation for the six automated journeys.
// Backend validates trigger_day, send_hour_ist, trigger_orders, and
// template_id (must be active + approved).

export async function getAutoJourneyConfig() {
  const { data } = await client.get('/api/restaurant/auto-journeys/config');
  return data;
}

export async function updateAutoJourneyConfig(body) {
  const { data } = await client.put('/api/restaurant/auto-journeys/config', body);
  return data;
}

export async function getAutoJourneyStats() {
  const { data } = await client.get('/api/restaurant/auto-journeys/stats');
  return data;
}

// ── Loyalty Program (Prompt 7) ──────────────────────────────────────
// Per-restaurant loyalty engine. Mounted at /loyalty-program to avoid
// collision with the legacy /loyalty/* endpoints (tiers + member
// table) still served by the restaurant router.

export async function getLoyaltyProgramConfig() {
  const { data } = await client.get('/api/restaurant/loyalty-program/config');
  return data;
}

export async function updateLoyaltyProgramConfig(body) {
  const { data } = await client.put('/api/restaurant/loyalty-program/config', body);
  return data;
}

export async function getLoyaltyProgramStats() {
  const { data } = await client.get('/api/restaurant/loyalty-program/stats');
  return data;
}

export async function lookupLoyaltyCustomer(phone) {
  const { data } = await client.get(
    `/api/restaurant/loyalty-program/customer/${encodeURIComponent(phone)}`,
  );
  return data;
}

export async function creditLoyaltyDineIn(body) {
  const { data } = await client.post('/api/restaurant/loyalty-program/dine-in-credit', body);
  return data;
}

// GET /api/restaurant/wallet/transactions?limit=
export async function getWalletTransactions(params = {}) {
  const { data } = await client.get('/api/restaurant/wallet/transactions', { params });
  return data;
}

// POST /api/restaurant/wallet/topup — body { amount_rs } → { razorpay_order_id, key_id }
export async function topUpWallet(payload) {
  const { data } = await client.post('/api/restaurant/wallet/topup', payload);
  return data;
}

// ── Settings tab ─────────────────────────────────────────────────────
// Business Information, Pricing & Charges, and Notifications all share the
// same PUT /api/restaurant endpoint — callers build the camelCase payload
// they want to save and we forward it.
// Legacy: settings.js:707 (doSaveProfile), 756 (doSaveChargeConfig), 730 (doSaveNotifySettings).
export async function updateRestaurantProfile(body) {
  const { data } = await client.put('/api/restaurant', body);
  return data;
}

// POST /api/restaurant/update-slug — body { slug } → { store_url }
// Legacy: settings.js:693 (doUpdateSlug).
export async function updateRestaurantSlug(slug) {
  const { data } = await client.post('/api/restaurant/update-slug', { slug });
  return data;
}

// POST /api/restaurant/whatsapp/disconnect
// Legacy: settings.js:1662 (doDisconnectWhatsapp).
export async function disconnectWhatsapp() {
  const { data } = await client.post('/api/restaurant/whatsapp/disconnect');
  return data;
}

// GET /api/restaurant/:id/waba-numbers — lists phone numbers attached to
// the restaurant's WABA. Backend verifies caller owns :id.
export async function getWabaNumbers(restaurantId) {
  const { data } = await client.get(`/api/restaurant/${restaurantId}/waba-numbers`);
  return data;
}

// PUT /api/restaurant/:id/marketing-number — body { phoneNumberId, displayName }.
// Pass phoneNumberId=null to clear.
export async function setMarketingNumber(restaurantId, body) {
  const { data } = await client.put(`/api/restaurant/${restaurantId}/marketing-number`, body);
  return data;
}

// POST /auth/change-password — body { currentPassword, newPassword } → { ok }
// Legacy: settings.js:1542 (doChangePassword).
export async function changePassword(body) {
  const { data } = await authClient.post('/auth/change-password', body);
  return data;
}

// DELETE /auth/delete-account — confirmation is client-side (type email to match).
// Legacy: settings.js:1562 (doDeleteAccount). Caller is responsible for clearing
// local auth state and redirecting.
export async function deleteAccount() {
  const { data } = await authClient.delete('/auth/delete-account');
  return data;
}

// ── Menu tab ─────────────────────────────────────────────────────────
// Legacy lives in frontend/js/tabs/menu.js (2,831 LoC). Covered here:
// menu editor CRUD, categories, bulk availability, variants, branch
// assignment, catalog push/pull, product sets, collections, CSV import,
// XLSX wizard, image uploads, image stats.

// GET /api/restaurant/menu/unassigned → Item[] (menu.js:816)
export async function getMenuUnassigned() {
  const { data } = await client.get('/api/restaurant/menu/unassigned');
  return data;
}

// GET /api/restaurant/branches/:branchId/menu → Group[] (menu.js:838)
export async function getBranchMenu(branchId) {
  const { data } = await client.get(`/api/restaurant/branches/${branchId}/menu`);
  return data;
}

// GET /api/restaurant/branches/:branchId/categories (menu.js:781, 1064)
export async function getBranchCategories(branchId) {
  const { data } = await client.get(`/api/restaurant/branches/${branchId}/categories`);
  return data;
}

// POST /api/restaurant/branches/:branchId/categories body { name }
export async function createBranchCategory(branchId, name) {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/categories`, { name });
  return data;
}

// PUT /api/restaurant/branches/:branchId/categories/:id body { name }
export async function updateBranchCategory(branchId, id, name) {
  const { data } = await client.put(`/api/restaurant/branches/${branchId}/categories/${id}`, { name });
  return data;
}

// DELETE /api/restaurant/branches/:branchId/categories/:id
export async function deleteBranchCategory(branchId, id) {
  const { data } = await client.delete(`/api/restaurant/branches/${branchId}/categories/${id}`);
  return data;
}

// POST /api/restaurant/branches/:branchId/menu — add-item payload shape
// per menu.js:1213-1254 (camelCase — priceRs, foodType, categoryId, imageUrl,
// thumbnailUrl, imageS3Key, itemGroupId, variantType, variantValue, size,
// salePriceRs, quantityToSellOnFacebook, productTags[])
export async function createBranchMenuItem(branchId, body) {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/menu`, body);
  return data;
}

// PATCH /api/restaurant/menu/:id/availability body { available } (menu.js:1400)
export async function updateItemAvailability(id, available) {
  const { data } = await client.patch(`/api/restaurant/menu/${id}/availability`, { available });
  return data;
}

// PATCH /api/restaurant/menu/:id/availability-all-branches body { available } (menu.js:1396)
// → { affected_branches }
export async function updateItemAvailabilityAllBranches(id, available) {
  const { data } = await client.patch(`/api/restaurant/menu/${id}/availability-all-branches`, { available });
  return data;
}

// PATCH /api/restaurant/menu/bulk-availability body { available, branch_id? } (menu.js:1437)
// → { updated_count }
export async function bulkUpdateAvailability(body) {
  const { data } = await client.patch('/api/restaurant/menu/bulk-availability', body);
  return data;
}

// DELETE /api/restaurant/menu/:id (menu.js:1458)
export async function deleteMenuItem(id) {
  const { data } = await client.delete(`/api/restaurant/menu/${id}`);
  return data;
}

// POST /api/restaurant/menu/bulk-delete body { ids[] } → { deleted } (menu.js:1491)
export async function bulkDeleteMenuItems(ids) {
  const { data } = await client.post('/api/restaurant/menu/bulk-delete', { ids });
  return data;
}

// POST /api/restaurant/menu/:id/variants body { variantLabel, variantType, priceRs, baseLabel } (menu.js:2222)
export async function addVariant(id, body) {
  const { data } = await client.post(`/api/restaurant/menu/${id}/variants`, body);
  return data;
}

// POST /api/restaurant/products/:productId/assign-branch body
// { branch_id, price, tax_percentage?, availability } (menu.js:2560)
export async function assignProductToBranch(productId, body) {
  const { data } = await client.post(`/api/restaurant/products/${productId}/assign-branch`, body);
  return data;
}

// GET /api/restaurant/products/branch-suggestions (menu.js:2737)
// → { suggestions: [{product_id, suggested_branch_ids[], reason}] }
export async function getBranchSuggestions() {
  const { data } = await client.get('/api/restaurant/products/branch-suggestions');
  return data;
}

// ── Catalog sync ─────────────────────────────────────────────────────

// POST /api/restaurant/catalog/sync → { totalSynced, totalFailed } (menu.js:1290)
export async function syncCatalog() {
  const { data } = await client.post('/api/restaurant/catalog/sync');
  return data;
}

// POST /api/restaurant/catalog/reverse-sync
// → { new_items_added, existing_items_updated } (menu.js:1309)
export async function reverseSyncCatalog() {
  const { data } = await client.post('/api/restaurant/catalog/reverse-sync');
  return data;
}

// GET /api/restaurant/catalog/sync-status → { lastSyncToMeta, lastSyncFromMeta } (menu.js:1324)
export async function getCatalogSyncStatus() {
  const { data } = await client.get('/api/restaurant/catalog/sync-status');
  return data;
}

// POST /api/restaurant/branches/:branchId/sync-catalog
// → { success, updated, errors[] } (menu.js:1278)
export async function quickSyncBranchCatalog(branchId) {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/sync-catalog`);
  return data;
}

// POST /api/restaurant/branches/:branchId/sync-sets (menu.js:1880)
export async function syncBranchSets(branchId) {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/sync-sets`);
  return data;
}

// POST /api/restaurant/branches/:branchId/fix-catalog → { catalogId? } (menu.js:1351)
export async function fixBranchCatalog(branchId) {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/fix-catalog`);
  return data;
}

// PATCH /api/restaurant/branches/:branchId body { catalogId } (menu.js:1366)
// Used by the manual-ID fallback after fix-catalog fails.
export async function patchBranch(branchId, body) {
  const { data } = await client.patch(`/api/restaurant/branches/${branchId}`, body);
  return data;
}

// ── Product sets ─────────────────────────────────────────────────────

// GET /api/restaurant/product-sets?branch_id=:id (menu.js:1897)
export async function getProductSets(branchId) {
  const { data } = await client.get('/api/restaurant/product-sets', { params: { branch_id: branchId } });
  return data;
}

// POST /api/restaurant/product-sets body
// { branchId, name, type:'category'|'tag'|'manual', filterValue, manualRetailerIds[], sortOrder } (menu.js:1970)
export async function createProductSet(body) {
  const { data } = await client.post('/api/restaurant/product-sets', body);
  return data;
}

// PUT /api/restaurant/product-sets/:id (same body shape) (menu.js:1967)
export async function updateProductSet(id, body) {
  const { data } = await client.put(`/api/restaurant/product-sets/${id}`, body);
  return data;
}

// DELETE /api/restaurant/product-sets/:id (menu.js:1981)
export async function deleteProductSet(id) {
  const { data } = await client.delete(`/api/restaurant/product-sets/${id}`);
  return data;
}

// POST /api/restaurant/product-sets/auto-create body { branchId } (menu.js:1991)
export async function autoCreateProductSets(branchId) {
  const { data } = await client.post('/api/restaurant/product-sets/auto-create', { branchId });
  return data;
}

// POST /api/restaurant/product-sets/sync body { branchId } (menu.js:2001)
export async function syncProductSets(branchId) {
  const { data } = await client.post('/api/restaurant/product-sets/sync', { branchId });
  return data;
}

// ── Collections ──────────────────────────────────────────────────────

// GET /api/restaurant/collections?branch_id=:id (menu.js:2019)
export async function getCollections(branchId) {
  const { data } = await client.get('/api/restaurant/collections', { params: { branch_id: branchId } });
  return data;
}

// POST /api/restaurant/collections body
// { branchId, name, description, productSetIds[], coverImageUrl, sortOrder } (menu.js:2150)
export async function createCollection(body) {
  const { data } = await client.post('/api/restaurant/collections', body);
  return data;
}

// PUT /api/restaurant/collections/:id (same body shape) (menu.js:2147)
export async function updateCollection(id, body) {
  const { data } = await client.put(`/api/restaurant/collections/${id}`, body);
  return data;
}

// DELETE /api/restaurant/collections/:id (menu.js:2161)
export async function deleteCollection(id) {
  const { data } = await client.delete(`/api/restaurant/collections/${id}`);
  return data;
}

// PUT /api/restaurant/collections/reorder body { items: [{id, sort_order}] } (menu.js:2068)
export async function reorderCollections(items) {
  const { data } = await client.put('/api/restaurant/collections/reorder', { items });
  return data;
}

// POST /api/restaurant/collections/auto-create body { branchId } (menu.js:2171)
export async function autoCreateCollections(branchId) {
  const { data } = await client.post('/api/restaurant/collections/auto-create', { branchId });
  return data;
}

// POST /api/restaurant/collections/sync body { branchId } (menu.js:2181)
export async function syncCollections(branchId) {
  const { data } = await client.post('/api/restaurant/collections/sync', { branchId });
  return data;
}

// ── CSV import (inline mapper) ───────────────────────────────────────

// POST /api/restaurant/branches/:branchId/menu/csv body { items[] } (menu.js:1784)
// Response: { added, skipped, errors[], per_branch[], unmatched_branches[], stale_items:{total, per_branch[], warnings[]} }
export async function uploadMenuCsv(branchId, items) {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/menu/csv`, { items });
  return data;
}

// POST /api/restaurant/menu/csv body { items[], branchId } (menu.js:1781)
// Multi-branch variant — branchId is the fallback for rows without a branch column match.
export async function uploadMultiBranchMenuCsv(body) {
  const { data } = await client.post('/api/restaurant/menu/csv', body);
  return data;
}

// ── XLSX menu import wizard ──────────────────────────────────────────

// POST /api/restaurant/menu/upload (multipart: file) → { upload_id } (menu.js:2644)
// Manual Authorization header — axios interceptor skips when header already set,
// but FormData + fetch is simpler here. Uses zm_token (our auth key).
export async function uploadMenuXlsx(file) {
  const form = new FormData();
  form.append('file', file);
  const token = localStorage.getItem('zm_token') || '';
  const res = await fetch('/api/restaurant/menu/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// POST /api/restaurant/menu/mapping body { upload_id }
// → { column_mapping, detected_headers[], sample_rows[] } (menu.js:2653)
export async function getMenuMapping(uploadId) {
  const { data } = await client.post('/api/restaurant/menu/mapping', { upload_id: uploadId });
  return data;
}

// POST /api/restaurant/menu/import body { upload_id, column_mapping }
// → { total, inserted, skipped, ready, incomplete } (menu.js:2701)
export async function importMenu(uploadId, columnMapping) {
  const { data } = await client.post('/api/restaurant/menu/import', {
    upload_id: uploadId,
    column_mapping: columnMapping,
  });
  return data;
}

// ── Image uploads ────────────────────────────────────────────────────

// POST /api/restaurant/menu/upload-image (multipart: image)
// → { url, thumbnail_url, s3_key } (menu.js:2277)
// Manual Authorization header via zm_token.
export async function uploadMenuImage(file) {
  const form = new FormData();
  form.append('image', file);
  const token = localStorage.getItem('zm_token') || '';
  const res = await fetch('/api/restaurant/menu/upload-image', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// POST /api/restaurant/images/bulk-upload (multipart: images[])
// → { matched:[{fileName,itemName}], unmatched:[{fileName}], uploaded } (menu.js:2380)
// Manual Authorization header via zm_token.
export async function bulkUploadImages(files) {
  const form = new FormData();
  for (const f of files) form.append('images', f);
  const token = localStorage.getItem('zm_token') || '';
  const res = await fetch('/api/restaurant/images/bulk-upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Bulk upload failed');
  return data;
}

// GET /api/restaurant/images/stats → { withImages, totalItems } (menu.js:2334)
export async function getImageStats() {
  const { data } = await client.get('/api/restaurant/images/stats');
  return data;
}

// ── Phase 2l: Branches + Users ───────────────────────────────────────

// POST /api/restaurant/branches (menu.js:270)
// Body shape: name, city, address, latitude, longitude, pincode, area, state,
// place_id, deliveryRadiusKm, openingTime, closingTime, managerPhone,
// fssai_number (14 digits required), gst_number? (15-char GSTIN optional).
export async function createBranch(body) {
  const { data } = await client.post('/api/restaurant/branches', body);
  return data;
}

// PATCH /api/restaurant/branches/:id (menu.js:489, 576)
// Same endpoint as patchBranch — kept as a second named export so callers
// reading "updateBranch" match the spec's vocabulary.
export async function updateBranch(id, body) {
  const { data } = await client.patch(`/api/restaurant/branches/${id}`, body);
  return data;
}

// POST /api/restaurant/branches/csv (menu.js:217) — body { branches: [ … ] }
// Geocoding happens client-side before this call (Nominatim, 1 req/sec).
export async function importBranchesCsv(branchesBody) {
  const { data } = await client.post('/api/restaurant/branches/csv', { branches: branchesBody });
  return data;
}

// GET /api/restaurant/branches/:id/hours → { hours: { monday:{open,close,is_closed}, … } } (restaurant.js:900)
export async function getBranchHours(branchId) {
  const { data } = await client.get(`/api/restaurant/branches/${branchId}/hours`);
  return data;
}

// PUT /api/restaurant/branches/:id/hours body { hours } (restaurant.js:1015)
export async function updateBranchHours(branchId, hours) {
  const { data } = await client.put(`/api/restaurant/branches/${branchId}/hours`, { hours });
  return data;
}

// POST /api/restaurant/branches/:id/create-catalog (menu.js:432)
// → { success, alreadyExists?, error? }
export async function createBranchCatalog(branchId) {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/create-catalog`);
  return data;
}

// POST /api/restaurant/branches/:id/sync-catalog (menu.js:451)
// Same endpoint as quickSyncBranchCatalog; aliased to match spec wording.
export async function syncBranchCatalog(branchId) {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/sync-catalog`);
  return data;
}

// GET /api/restaurant/places/autocomplete?input=… → { suggestions: [...] } (menu.js:49)
export async function placesAutocomplete(input) {
  const { data } = await client.get(`/api/restaurant/places/autocomplete?input=${encodeURIComponent(input)}`);
  return data;
}

// GET /api/restaurant/places/details?placeId=… → { full_address, city, lat, lng, area, pincode, state, place_id } (menu.js:92)
export async function placesDetails(placeId) {
  const { data } = await client.get(`/api/restaurant/places/details?placeId=${encodeURIComponent(placeId)}`);
  return data;
}

// GET /api/restaurant/users → [{id,name,phone,role,branch_ids,is_active,last_login_at}] (restaurant.js:271)
export async function getUsers() {
  const { data } = await client.get('/api/restaurant/users');
  return data;
}

// POST /api/restaurant/users (restaurant.js:336)
// Body: { name, phone, pin (4-6 digits), role, branchIds? }
export async function createUser(body) {
  const { data } = await client.post('/api/restaurant/users', body);
  return data;
}

// PUT /api/restaurant/users/:id (restaurant.js:332)
// Body on edit: { name, role, branchIds? } — phone & PIN are NOT editable.
// Body on reactivate: { isActive: true }
export async function updateUser(id, body) {
  const { data } = await client.put(`/api/restaurant/users/${id}`, body);
  return data;
}

// DELETE /api/restaurant/users/:id (restaurant.js:374) — "deactivate" in legacy vocabulary
export async function deleteUser(id) {
  const { data } = await client.delete(`/api/restaurant/users/${id}`);
  return data;
}

// PUT /api/restaurant/users/:id/reset-pin body { pin } (restaurant.js:365)
export async function resetUserPin(id, pin) {
  const { data } = await client.put(`/api/restaurant/users/${id}/reset-pin`, { pin });
  return data;
}

// ── Ratings tab ──────────────────────────────────────────────────────
// Mirrors loadRatings() in legacy js/tabs/restaurant.js:149.

// GET /api/restaurant/ratings/summary?branch_id=
// → { total, avg_overall, avg_taste, avg_packing, avg_delivery, avg_value, recent_comments[] }
export async function getRatingsSummary(params = {}) {
  const { data } = await client.get('/api/restaurant/ratings/summary', { params });
  return data;
}

// GET /api/restaurant/ratings?page=&limit=&branch_id=
// → { ratings: [{order_number, customer_name, branch_name, taste_rating, packing_rating,
//                delivery_rating, value_rating, overall_rating, comment, created_at}], total, pages }
export async function getRatings(params = {}) {
  const { data } = await client.get('/api/restaurant/ratings', { params });
  return data;
}

// Legacy loyalty helpers (getLoyaltyStats / getLoyaltyCustomers) have
// been removed. Use the unified /api/restaurant/loyalty-program/*
// helpers at the top of this file (getLoyaltyProgramStats,
// lookupLoyaltyCustomer, etc.).

// ═══════════════════════════════════════════════════════════════
// Unified feedback & review funnel (Prompt 8)
// ═══════════════════════════════════════════════════════════════

// POST /api/restaurant/feedback/dine-in/send
//   body: { phone, customer_name?, outlet_id?, order_ref? }
export async function sendDineInFeedback(body) {
  const { data } = await client.post('/api/restaurant/feedback/dine-in/send', body);
  return data;
}

// GET /api/restaurant/feedback/events
export async function getFeedbackEvents(params = {}) {
  const { data } = await client.get('/api/restaurant/feedback/events', { params });
  return data;
}

// GET /api/restaurant/feedback/stats?window=30d
export async function getFeedbackStats(params = {}) {
  const { data } = await client.get('/api/restaurant/feedback/stats', { params });
  return data;
}

// GET /api/restaurant/feedback/escalations?include_resolved=true|false
export async function getFeedbackEscalations(params = {}) {
  const { data } = await client.get('/api/restaurant/feedback/escalations', { params });
  return data;
}

// PATCH /api/restaurant/feedback/escalations/:id/resolve
export async function resolveFeedbackEscalation(id, note) {
  const { data } = await client.patch(`/api/restaurant/feedback/escalations/${id}/resolve`, { note });
  return data;
}

// GET /api/restaurant/feedback/notifications
export async function getRestaurantNotifications(params = {}) {
  const { data } = await client.get('/api/restaurant/feedback/notifications', { params });
  return data;
}

// PATCH /api/restaurant/feedback/notifications/:id/read
export async function markNotificationRead(id) {
  const { data } = await client.patch(`/api/restaurant/feedback/notifications/${id}/read`);
  return data;
}

// PATCH /api/restaurant/feedback/notifications/read-all
export async function markAllNotificationsRead() {
  const { data } = await client.patch('/api/restaurant/feedback/notifications/read-all');
  return data;
}

// GET /api/restaurant/feedback/settings/review-links
export async function getReviewLinks() {
  const { data } = await client.get('/api/restaurant/feedback/settings/review-links');
  return data;
}

// PATCH /api/restaurant/feedback/settings/review-links
//   body: { google_review_link?, zomato_review_link? }
export async function updateReviewLinks(body) {
  const { data } = await client.patch('/api/restaurant/feedback/settings/review-links', body);
  return data;
}

// GET /api/restaurant/festivals/upcoming
// Festival calendar rows in the next 60 days. Each row includes
// days_until + already_sent so the campaign wizard can render a
// festival nudge banner with a pre-filled template use_case.
export async function getUpcomingFestivals() {
  const { data } = await client.get('/api/restaurant/festivals/upcoming');
  return data;
}

// GET /api/restaurant/campaigns/smart-send-time
// Returns the peak-hour recommendation, or null if the tenant has
// fewer than 20 paid orders in the last 90 days.
export async function getCampaignSmartSendTime() {
  const { data } = await client.get('/api/restaurant/campaigns/smart-send-time');
  return data;
}

// ─── Marketing Analytics (Prompt 10) ─────────────────────────────
// All endpoints accept ?period=7d|30d|90d|all (default 30d).
export async function getMarketingAnalyticsDashboard(period = '30d') {
  const { data } = await client.get('/api/restaurant/marketing-analytics/dashboard', { params: { period } });
  return data;
}

export async function getMarketingAnalyticsSection(section, period = '30d') {
  const { data } = await client.get(`/api/restaurant/marketing-analytics/${section}`, { params: { period } });
  return data;
}
