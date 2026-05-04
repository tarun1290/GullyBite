import client from '../lib/apiClient';
import type { AxiosResponse } from 'axios';
import type {
  AnalyticsSummary,
  Branch,
  BranchHours,
  BranchStaffLink,
  Campaign,
  MenuAllResponse,
  Order,
  PenaltiesSummary,
  QueryParams,
  RequestBody,
  Restaurant,
} from '../types';

// All endpoints below mirror frontend/src/api/restaurant.js (169 exports).
// Same names, methods, URLs, and default parameter values. Returns are
// typed where the source's JSDoc + caller usage pin the shape; other
// returns use `unknown`.

// ── Profile / orders / branches / menu ──────────────────────────────

export async function getRestaurantProfile(): Promise<Restaurant> {
  const { data } = await client.get<Restaurant>('/api/restaurant');
  return data;
}

export async function getAnalyticsSummary(days: number = 1): Promise<AnalyticsSummary> {
  const { data } = await client.get<AnalyticsSummary>('/api/restaurant/analytics', { params: { days } });
  return data;
}

export async function getRestaurantOrders(params: QueryParams = {}): Promise<Order[]> {
  const { data } = await client.get<Order[]>('/api/restaurant/orders', { params });
  return data;
}

export async function getOrders(params: QueryParams = {}): Promise<Order[]> {
  const { data } = await client.get<Order[]>('/api/restaurant/orders', { params });
  return data;
}

export async function getOrderById(id: string): Promise<Order> {
  const { data } = await client.get<Order>(`/api/restaurant/orders/${id}`);
  return data;
}

export async function updateOrderStatus(id: string, status: string): Promise<unknown> {
  const { data } = await client.patch(`/api/restaurant/orders/${id}/status`, { status });
  return data;
}

// Dedicated accept/decline endpoints. Distinct from updateOrderStatus
// because they encode the merchant-acknowledge contract:
//   /accept  → PAID → CONFIRMED + stamps acknowledged_at (idempotent)
//   /decline → PAID → REJECTED_BY_RESTAURANT + Razorpay refund +
//              cancellation fault-fee accounting
// These are the only valid surfaces for accept/decline — calling
// updateOrderStatus with 'CONFIRMED' technically works for accept but
// skips the ack stamp; calling it with 'REJECTED_BY_RESTAURANT' bypasses
// the refund entirely.
export async function acceptOrder(id: string): Promise<{ success: boolean; status?: string; alreadyAcknowledged?: boolean }> {
  const { data } = await client.post(`/api/restaurant/orders/${id}/accept`);
  return data as { success: boolean; status?: string; alreadyAcknowledged?: boolean };
}

export async function declineOrder(id: string, reason?: string): Promise<{ success: boolean; status?: string; refundId?: string | null }> {
  const { data } = await client.post(`/api/restaurant/orders/${id}/decline`, reason ? { reason } : {});
  return data as { success: boolean; status?: string; refundId?: string | null };
}

export async function dispatchOrder(id: string, payload: RequestBody = {}): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/orders/${id}/dispatch`, payload);
  return data;
}

export async function cancelDelivery(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/orders/${id}/cancel-delivery`);
  return data;
}

export async function getDeliveryStatus(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/orders/${id}/delivery`);
  return data;
}

export async function reportFakeDelivery(id: string): Promise<{ success: boolean; issue_id: string }> {
  const { data } = await client.post(`/api/restaurant/orders/${id}/report-fake-delivery`);
  return data as { success: boolean; issue_id: string };
}

export async function getBranches(): Promise<Branch[]> {
  const { data } = await client.get<Branch[]>('/api/restaurant/branches');
  return data;
}

export async function getMenuAll(): Promise<MenuAllResponse> {
  const { data } = await client.get<MenuAllResponse>('/api/restaurant/menu/all');
  return data;
}

export async function getMessagingStatus(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/messaging-status');
  return data;
}

// ── Messages tab ────────────────────────────────────────────────────

export async function getMessages(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/messages', { params });
  return data;
}

export async function getThread(customerId: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/messages/thread/${customerId}`);
  return data;
}

export async function replyToThread(customerId: string, payload: RequestBody): Promise<unknown> {
  const body: RequestBody = { customer_id: customerId, ...payload };
  const { data } = await client.post('/api/restaurant/messages/reply', body);
  return data;
}

export async function getUnreadCount(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/messages/unread-count');
  return data;
}

export async function resolveThread(customerId: string): Promise<unknown> {
  const { data } = await client.put(`/api/restaurant/messages/thread/${customerId}/resolve`);
  return data;
}

// ── Issues tab ──────────────────────────────────────────────────────

export async function getIssues(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/issues', { params });
  return data;
}

export async function getIssueById(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/issues/${id}`);
  return data;
}

export async function replyToIssue(id: string, payload: RequestBody): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/issues/${id}/message`, payload);
  return data;
}

export async function resolveIssue(id: string, payload: RequestBody = {}): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/issues/${id}/resolve`, payload);
  return data;
}

export async function escalateIssue(id: string, payload: RequestBody = {}): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/issues/${id}/escalate`, payload);
  return data;
}

export async function reopenIssue(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/issues/${id}/reopen`, {});
  return data;
}

// ── Analytics tab ───────────────────────────────────────────────────

export async function getAnalyticsOverview(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/analytics/overview', { params });
  return data;
}

export async function getRevenueAnalytics(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/analytics/revenue', { params });
  return data;
}

export async function getTopItems(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/analytics/top-items', { params });
  return data;
}

export async function getPeakHours(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/analytics/peak-hours', { params });
  return data;
}

export async function getCustomerAnalytics(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/analytics/customers', { params });
  return data;
}

export async function getDeliveryAnalytics(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/analytics/delivery', { params });
  return data;
}

export async function getDropoffs(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/analytics/dropoffs', { params });
  return data;
}

export async function getRecoveryStats(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/analytics/recovery-stats', { params });
  return data;
}

export async function getCartRecovery(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/analytics/cart-recovery', { params });
  return data;
}

export async function recoverDropoff(convId: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/dropoffs/${convId}/recover`);
  return data;
}

// ── Marketing tab ───────────────────────────────────────────────────

export async function getCampaigns(): Promise<Campaign[]> {
  const { data } = await client.get<Campaign[]>('/api/restaurant/campaigns');
  return data;
}

export async function createCampaign(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/campaigns', body);
  return data;
}

export async function sendCampaign(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/campaigns/${id}/send`);
  return data;
}

export async function pauseCampaign(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/campaigns/${id}/pause`);
  return data;
}

export async function resumeCampaign(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/campaigns/${id}/resume`);
  return data;
}

export async function deleteCampaign(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/restaurant/campaigns/${id}`);
  return data;
}

export async function getCampaignDailyUsage(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/campaigns/daily-usage');
  return data;
}

export async function getCampaignAnalytics(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/campaigns/analytics', { params });
  return data;
}

export async function getCustomerTags(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/customers/tags');
  return data;
}

export async function getBranchItems(branchId: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/branches/${branchId}/items`);
  return data;
}

export async function getCoupons(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/coupons');
  return data;
}

export async function createCoupon(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/coupons', body);
  return data;
}

export async function updateCoupon(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.patch(`/api/restaurant/coupons/${id}`, body);
  return data;
}

export async function deleteCoupon(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/restaurant/coupons/${id}`);
  return data;
}

export async function getReferrals(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/referrals');
  return data;
}

export async function getReferralLinks(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/referrals/links');
  return data;
}

export async function requestReferralLink(campaignName?: string): Promise<unknown> {
  const body: RequestBody = campaignName ? { campaign_name: campaignName } : {};
  const { data } = await client.post('/api/restaurant/referrals/links/request', body);
  return data;
}

export async function getMarketingMessages(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/marketing-messages', { params });
  return data;
}

// ── Payments tab ────────────────────────────────────────────────────

export async function getFinancialSummary(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/financials/summary', { params });
  return data;
}

export async function getDailyFinancials(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/financials/daily', { params });
  return data;
}

export async function getSettlements(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/financials/settlements', { params });
  return data;
}

export async function getPenalties(from?: string, to?: string): Promise<PenaltiesSummary> {
  const params: QueryParams = {};
  if (from) params.from = from;
  if (to) params.to = to;
  const { data } = await client.get<PenaltiesSummary>('/api/restaurant/penalties', { params });
  return data;
}

export async function getSettlementById(id: string, params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/financials/settlements/${id}`, { params });
  return data;
}

export async function getSettlementMetaBreakdown(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/settlements/${id}/meta-breakdown`);
  return data;
}

export async function downloadSettlement(id: string): Promise<AxiosResponse<Blob>> {
  const resp = await client.get<Blob>(`/api/restaurant/settlements/${id}/download`, {
    responseType: 'blob',
  });
  return resp;
}

export async function getPayments(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/financials/payments', { params });
  return data;
}

export async function getTaxSummary(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/financials/tax-summary');
  return data;
}

export async function getWallet(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/wallet');
  return data;
}

export async function getMarketingWaStatus(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/settings/marketing-wa');
  return data;
}

export async function saveMarketingWaNumber(payload: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/settings/marketing-wa', payload);
  return data;
}

export async function getCustomerStats(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/customers/stats');
  return data;
}

export async function getCustomerSegments(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/customers/segments');
  return data;
}

export async function getCustomersBySegment(label: string, limit: number = 20): Promise<unknown> {
  const { data } = await client.get(
    `/api/restaurant/customers/by-segment/${encodeURIComponent(label)}`,
    { params: { limit } },
  );
  return data;
}

export async function getCampaignTemplates(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/campaign-templates', { params });
  return data;
}

export async function getCampaignTemplate(templateId: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/campaign-templates/${encodeURIComponent(templateId)}`);
  return data;
}

// ── Marketing campaigns (manual blasts) ─────────────────────────────

export async function createMarketingCampaign(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/marketing-campaigns/create', body);
  return data;
}

export async function getMarketingCampaigns(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/marketing-campaigns', { params });
  return data;
}

export async function getMarketingCampaign(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/marketing-campaigns/${encodeURIComponent(id)}`);
  return data;
}

export async function cancelMarketingCampaign(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/marketing-campaigns/${encodeURIComponent(id)}/cancel`);
  return data;
}

export async function getMarketingCampaignSummary(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/marketing-campaigns/stats/summary');
  return data;
}

// ── Auto journeys ───────────────────────────────────────────────────

export async function getAutoJourneyConfig(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/auto-journeys/config');
  return data;
}

export async function updateAutoJourneyConfig(body: RequestBody): Promise<unknown> {
  const { data } = await client.put('/api/restaurant/auto-journeys/config', body);
  return data;
}

export async function getAutoJourneyStats(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/auto-journeys/stats');
  return data;
}

// ── Loyalty Program ─────────────────────────────────────────────────

export async function getLoyaltyProgramConfig(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/loyalty-program/config');
  return data;
}

export async function updateLoyaltyProgramConfig(body: RequestBody): Promise<unknown> {
  const { data } = await client.put('/api/restaurant/loyalty-program/config', body);
  return data;
}

export async function getLoyaltyProgramStats(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/loyalty-program/stats');
  return data;
}

export async function lookupLoyaltyCustomer(phone: string): Promise<unknown> {
  const { data } = await client.get(
    `/api/restaurant/loyalty-program/customer/${encodeURIComponent(phone)}`,
  );
  return data;
}

export async function creditLoyaltyDineIn(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/loyalty-program/dine-in-credit', body);
  return data;
}

export async function getWalletTransactions(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/wallet/transactions', { params });
  return data;
}

export async function topUpWallet(payload: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/wallet/topup', payload);
  return data;
}

// ── Settings tab ────────────────────────────────────────────────────

export async function updateRestaurantProfile(body: RequestBody): Promise<unknown> {
  const { data } = await client.put('/api/restaurant', body);
  return data;
}

export async function updateRestaurantSlug(slug: string): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/update-slug', { slug });
  return data;
}

export async function disconnectWhatsapp(): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/whatsapp/disconnect');
  return data;
}

export async function getWabaNumbers(restaurantId: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/${restaurantId}/waba-numbers`);
  return data;
}

export async function setMarketingNumber(restaurantId: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.put(`/api/restaurant/${restaurantId}/marketing-number`, body);
  return data;
}

export async function changePassword(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/auth/change-password', body);
  return data;
}

export async function deleteAccount(): Promise<unknown> {
  const { data } = await client.delete('/auth/delete-account');
  return data;
}

// ── Menu tab ────────────────────────────────────────────────────────

export async function getMenuUnassigned(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/menu/unassigned');
  return data;
}

export async function getBranchMenu(branchId: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/branches/${branchId}/menu`);
  return data;
}

export async function getBranchCategories(branchId: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/branches/${branchId}/categories`);
  return data;
}

export async function createBranchCategory(branchId: string, name: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/categories`, { name });
  return data;
}

export async function updateBranchCategory(branchId: string, id: string, name: string): Promise<unknown> {
  const { data } = await client.put(`/api/restaurant/branches/${branchId}/categories/${id}`, { name });
  return data;
}

export async function deleteBranchCategory(branchId: string, id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/restaurant/branches/${branchId}/categories/${id}`);
  return data;
}

export async function createBranchMenuItem(branchId: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/menu`, body);
  return data;
}

// Partial-update an existing menu item. Backed by PUT /api/restaurant/menu/:id
// (the existing route — same one the availability toggle path goes through
// when more than just `available` changes). Send only the fields you want
// to change; immutable fields (_id, restaurant_id, created_at) are rejected
// at the writer. Successful updates trigger an activity_logs entry and a
// debounced catalog sync to Meta.
export async function updateMenuItem(itemId: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.put(`/api/restaurant/menu/${itemId}`, body);
  return data;
}

export async function updateItemAvailability(id: string, available: boolean): Promise<unknown> {
  const { data } = await client.patch(`/api/restaurant/menu/${id}/availability`, { available });
  return data;
}

export async function updateItemAvailabilityAllBranches(id: string, available: boolean): Promise<unknown> {
  const { data } = await client.patch(`/api/restaurant/menu/${id}/availability-all-branches`, { available });
  return data;
}

export async function bulkUpdateAvailability(body: RequestBody): Promise<unknown> {
  const { data } = await client.patch('/api/restaurant/menu/bulk-availability', body);
  return data;
}

export async function deleteMenuItem(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/restaurant/menu/${id}`);
  return data;
}

export async function bulkDeleteMenuItems(ids: string[]): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/menu/bulk-delete', { ids });
  return data;
}

export async function addVariant(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/menu/${id}/variants`, body);
  return data;
}

export async function assignProductToBranch(productId: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/products/${productId}/assign-branch`, body);
  return data;
}

export async function getBranchSuggestions(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/products/branch-suggestions');
  return data;
}

// ── Catalog sync ────────────────────────────────────────────────────

export async function syncCatalog(): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/catalog/sync');
  return data;
}

export async function reverseSyncCatalog(): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/catalog/reverse-sync');
  return data;
}

export async function getCatalogSyncStatus(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/catalog/sync-status');
  return data;
}

export async function quickSyncBranchCatalog(branchId: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/sync-catalog`);
  return data;
}

export async function syncBranchSets(branchId: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/sync-sets`);
  return data;
}

export async function fixBranchCatalog(branchId: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/fix-catalog`);
  return data;
}

export async function patchBranch(branchId: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.patch(`/api/restaurant/branches/${branchId}`, body);
  return data;
}

// ── Product sets ────────────────────────────────────────────────────

export async function getProductSets(branchId: string): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/product-sets', { params: { branch_id: branchId } });
  return data;
}

export async function createProductSet(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/product-sets', body);
  return data;
}

export async function updateProductSet(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.put(`/api/restaurant/product-sets/${id}`, body);
  return data;
}

export async function deleteProductSet(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/restaurant/product-sets/${id}`);
  return data;
}

export async function autoCreateProductSets(branchId: string): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/product-sets/auto-create', { branchId });
  return data;
}

export async function syncProductSets(branchId: string): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/product-sets/sync', { branchId });
  return data;
}

// ── Collections ─────────────────────────────────────────────────────

export async function getCollections(branchId: string): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/collections', { params: { branch_id: branchId } });
  return data;
}

export async function createCollection(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/collections', body);
  return data;
}

export async function updateCollection(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.put(`/api/restaurant/collections/${id}`, body);
  return data;
}

export async function deleteCollection(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/restaurant/collections/${id}`);
  return data;
}

export async function reorderCollections(items: RequestBody[]): Promise<unknown> {
  const { data } = await client.put('/api/restaurant/collections/reorder', { items });
  return data;
}

export async function autoCreateCollections(branchId: string): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/collections/auto-create', { branchId });
  return data;
}

export async function syncCollections(branchId: string): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/collections/sync', { branchId });
  return data;
}

// ── CSV import ──────────────────────────────────────────────────────

export async function uploadMenuCsv(branchId: string, items: RequestBody[]): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/menu/csv`, { items });
  return data;
}

export async function uploadMultiBranchMenuCsv(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/menu/csv', body);
  return data;
}

// ── XLSX menu import wizard ─────────────────────────────────────────

export async function uploadMenuXlsx(file: File): Promise<unknown> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await client.post('/api/restaurant/menu/upload', form);
  return data;
}

export async function getMenuMapping(uploadId: string): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/menu/mapping', { upload_id: uploadId });
  return data;
}

export async function importMenu(uploadId: string, columnMapping: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/menu/import', {
    upload_id: uploadId,
    column_mapping: columnMapping,
  });
  return data;
}

// ── Image uploads ───────────────────────────────────────────────────

export async function uploadMenuImage(file: File): Promise<unknown> {
  const form = new FormData();
  form.append('image', file);
  const { data } = await client.post('/api/restaurant/menu/upload-image', form);
  return data;
}

export async function bulkUploadImages(files: File[]): Promise<unknown> {
  const form = new FormData();
  for (const f of files) form.append('images', f);
  const { data } = await client.post('/api/restaurant/images/bulk-upload', form);
  return data;
}

export async function getImageStats(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/images/stats');
  return data;
}

// ── Branches + Users ────────────────────────────────────────────────

// Backend appends the first-month subscription Razorpay order to the
// branch creation response. Frontend opens Checkout immediately, then
// posts the signed payment back to /branches/:id/activate-subscription.
export interface BranchRazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
}

export type CreateBranchResponse = Branch & { razorpay_order?: BranchRazorpayOrder };

export async function createBranch(body: RequestBody): Promise<CreateBranchResponse> {
  const { data } = await client.post<CreateBranchResponse>('/api/restaurant/branches', body);
  return data;
}

export async function activateBranchSubscription(
  branchId: string,
  body: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
): Promise<Branch> {
  const { data } = await client.post<Branch>(`/api/restaurant/branches/${branchId}/activate-subscription`, body);
  return data;
}

// Manual retry path for a branch the bi-monthly billing job paused
// because the wallet was empty. Server-side: charges the wallet for
// one cycle and flips subscription_status back to 'active'.
//   200 — { ok, paid_through_date }
//   400 — { error: 'Branch is not paused' }
//   400 — { error: 'Insufficient wallet balance', required_paise, current_paise }
//   502 — { error: 'Could not charge wallet' } (ledger debit failed)
export async function retryBranchBilling(branchId: string): Promise<{ ok: boolean; paid_through_date: string }> {
  const { data } = await client.post<{ ok: boolean; paid_through_date: string }>(
    `/api/restaurant/branches/${branchId}/billing-retry`,
  );
  return data;
}

export async function updateBranch(id: string, body: RequestBody): Promise<Branch> {
  const { data } = await client.patch<Branch>(`/api/restaurant/branches/${id}`, body);
  return data;
}

export async function softDeleteBranch(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/branches/${id}/soft-delete`);
  return data;
}

export async function restoreBranch(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/branches/${id}/restore`);
  return data;
}

export async function permanentDeleteBranch(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/restaurant/branches/${id}/permanent`);
  return data;
}

export async function getBranchStaffLink(branchId: string): Promise<BranchStaffLink> {
  const { data } = await client.get<BranchStaffLink>(
    `/api/restaurant/branches/${encodeURIComponent(branchId)}/staff-link`,
  );
  return data;
}

export async function generateBranchStaffLink(branchId: string): Promise<BranchStaffLink> {
  const { data } = await client.post<BranchStaffLink>(
    `/api/restaurant/branches/${encodeURIComponent(branchId)}/staff-link/generate`,
  );
  return data;
}

export async function importBranchesCsv(branchesBody: RequestBody[]): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/branches/csv', { branches: branchesBody });
  return data;
}

export async function getBranchHours(branchId: string): Promise<{ hours: BranchHours }> {
  const { data } = await client.get<{ hours: BranchHours }>(`/api/restaurant/branches/${branchId}/hours`);
  return data;
}

export async function updateBranchHours(branchId: string, hours: BranchHours): Promise<unknown> {
  const { data } = await client.put(`/api/restaurant/branches/${branchId}/hours`, { hours });
  return data;
}

export async function createBranchCatalog(branchId: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/create-catalog`);
  return data;
}

export async function syncBranchCatalog(branchId: string): Promise<unknown> {
  const { data } = await client.post(`/api/restaurant/branches/${branchId}/sync-catalog`);
  return data;
}

export async function placesAutocomplete(input: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/places/autocomplete?input=${encodeURIComponent(input)}`);
  return data;
}

export async function placesDetails(placeId: string): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/places/details?placeId=${encodeURIComponent(placeId)}`);
  return data;
}

export async function reverseGeocode(lat: number, lng: number): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/places/reverse-geocode', {
    params: { lat, lng },
  });
  return data;
}

export async function getUsers(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/users');
  return data;
}

export async function createUser(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/users', body);
  return data;
}

export async function updateUser(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.put(`/api/restaurant/users/${id}`, body);
  return data;
}

export async function deleteUser(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/restaurant/users/${id}`);
  return data;
}

export async function resetUserPin(id: string, pin: string): Promise<unknown> {
  const { data } = await client.put(`/api/restaurant/users/${id}/reset-pin`, { pin });
  return data;
}

// ── Ratings tab ─────────────────────────────────────────────────────

export async function getRatingsSummary(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/ratings/summary', { params });
  return data;
}

export async function getRatings(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/ratings', { params });
  return data;
}

// ── Unified feedback & review funnel ────────────────────────────────

export async function sendDineInFeedback(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/feedback/dine-in/send', body);
  return data;
}

export async function getFeedbackEvents(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/feedback/events', { params });
  return data;
}

export async function getFeedbackStats(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/feedback/stats', { params });
  return data;
}

export async function getFeedbackEscalations(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/feedback/escalations', { params });
  return data;
}

export async function resolveFeedbackEscalation(id: string, note: string): Promise<unknown> {
  const { data } = await client.patch(`/api/restaurant/feedback/escalations/${id}/resolve`, { note });
  return data;
}

export async function getRestaurantNotifications(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/feedback/notifications', { params });
  return data;
}

export async function markNotificationRead(id: string): Promise<unknown> {
  const { data } = await client.patch(`/api/restaurant/feedback/notifications/${id}/read`);
  return data;
}

export async function markAllNotificationsRead(): Promise<unknown> {
  const { data } = await client.patch('/api/restaurant/feedback/notifications/read-all');
  return data;
}

export async function getReviewLinks(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/feedback/settings/review-links');
  return data;
}

export async function updateReviewLinks(body: RequestBody): Promise<unknown> {
  const { data } = await client.patch('/api/restaurant/feedback/settings/review-links', body);
  return data;
}

export async function getUpcomingFestivals(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/festivals/upcoming');
  return data;
}

export async function getCampaignSmartSendTime(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/campaigns/smart-send-time');
  return data;
}

// ── Marketing Analytics ─────────────────────────────────────────────

export async function getMarketingAnalyticsDashboard(period: string = '30d'): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/marketing-analytics/dashboard', { params: { period } });
  return data;
}

export async function getMarketingAnalyticsSection(section: string, period: string = '30d'): Promise<unknown> {
  const { data } = await client.get(`/api/restaurant/marketing-analytics/${section}`, { params: { period } });
  return data;
}

// ── Catalog Management ──────────────────────────────────────────────

export async function getCatalogFullState(): Promise<unknown> {
  const { data } = await client.get('/api/restaurant/catalog/full-state');
  return data;
}

export interface ListCatalogsOptions {
  refresh?: boolean;
}

export async function listAvailableCatalogs(opts: ListCatalogsOptions = {}): Promise<unknown> {
  const { refresh = false } = opts;
  const { data } = await client.get('/api/restaurant/catalogs', {
    params: refresh ? { refresh: 'true' } : {},
  });
  return data;
}

export async function switchCatalog(catalogId: string): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/catalog/switch', { catalog_id: catalogId });
  return data;
}

export async function disconnectCatalogFromWaba(): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/catalog/disconnect-waba');
  return data;
}

export async function createNewCatalog(name: string): Promise<unknown> {
  const { data } = await client.post('/api/restaurant/catalog/create-new', { name });
  return data;
}

export async function deleteCatalog(catalogId: string): Promise<unknown> {
  const { data } = await client.delete(`/api/restaurant/catalog/${encodeURIComponent(catalogId)}`);
  return data;
}

// ── Admin ↔ Restaurant DM thread ────────────────────────────────
// Mounted at /admin-messages (NOT /messages — that's the existing
// customer inbox). Calling getAdminMessages() also marks all
// admin→restaurant rows as read server-side, clearing the unread
// badge for the merchant.
export async function getAdminMessages(): Promise<import('../types').AdminRestaurantMessagesResponse> {
  const { data } = await client.get<import('../types').AdminRestaurantMessagesResponse>(
    '/api/restaurant/admin-messages',
  );
  return data;
}

export async function replyAdminMessage(message: string): Promise<import('../types').AdminRestaurantMessage> {
  const { data } = await client.post<import('../types').AdminRestaurantMessage>(
    '/api/restaurant/admin-messages/reply',
    { message },
  );
  return data;
}
