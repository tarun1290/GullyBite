import client from '../lib/apiClient';
import type { AxiosResponse, RawAxiosResponseHeaders, AxiosResponseHeaders } from 'axios';
import type {
  AdminFeesSummary,
  AdminPlatformAbsorbedFee,
  AdminRestaurant,
  AdminRestaurantFaultFee,
  AuthResponse,
  AuthUser,
  QueryParams,
  RequestBody,
} from '../types';

// Mirrors frontend/src/api/admin.js (143 exports). Same names, methods,
// URLs, and default parameter values. Returns are typed where the
// source's JSDoc + caller usage pin the shape; other returns use `unknown`.

export type BlobDownload = {
  blob: Blob;
  headers: RawAxiosResponseHeaders | AxiosResponseHeaders;
};

// ── Admin Auth ──────────────────────────────────────────────────────

export async function getAdminSetupStatus(): Promise<{ needs_setup: boolean }> {
  const { data } = await client.get<{ needs_setup: boolean }>('/api/admin/auth/setup-status');
  return data;
}

export async function adminSignin(email: string, password: string): Promise<AuthResponse> {
  const { data } = await client.post<AuthResponse>('/api/admin/auth', { email, password });
  return data;
}

export async function adminSetup(email: string, password: string, name: string): Promise<AuthResponse> {
  const { data } = await client.post<AuthResponse>('/api/admin/auth/setup', { email, password, name });
  return data;
}

export async function getAdminMe(): Promise<AuthUser> {
  const { data } = await client.get<AuthUser>('/api/admin/auth/me');
  return data;
}

// ── Flows ───────────────────────────────────────────────────────────

export async function getFlows(): Promise<unknown> {
  const { data } = await client.get('/api/admin/flows');
  return data;
}

export async function getFlowJson(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/admin/flows/${id}/json`);
  return data;
}

export async function updateFlow(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.put(`/api/admin/flows/${id}`, body);
  return data;
}

export async function publishFlow(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/flows/${id}/publish`);
  return data;
}

export async function deprecateFlow(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/flows/${id}/deprecate`);
  return data;
}

export async function deleteFlow(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/admin/flows/${id}`);
  return data;
}

export async function getFlowAssignments(): Promise<unknown> {
  const { data } = await client.get('/api/admin/flows/assignments');
  return data;
}

export async function assignFlowAs(type: string, flowId: string, flowName: string): Promise<unknown> {
  const { data } = await client.put('/api/admin/flows/assignments', {
    type,
    flow_id: flowId,
    flow_name: flowName,
  });
  return data;
}

export async function getFlowTemplates(): Promise<unknown> {
  const { data } = await client.get('/api/admin/flows/templates');
  return data;
}

export async function createFlow(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/admin/flows', body);
  return data;
}

// ── Templates ───────────────────────────────────────────────────────

export async function getTemplates(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/templates', { params });
  return data;
}

export async function getTemplateGallery(): Promise<unknown> {
  const { data } = await client.get('/api/admin/templates/gallery');
  return data;
}

export async function createTemplate(payload: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/admin/templates', payload);
  return data;
}

export async function deleteTemplate(body: string | RequestBody): Promise<unknown> {
  const payload: RequestBody = typeof body === 'string' ? { name: body } : body;
  const { data } = await client.delete('/api/admin/templates', { data: payload });
  return data;
}

export async function getTemplateMappings(): Promise<unknown> {
  const { data } = await client.get('/api/admin/templates/mappings');
  return data;
}

export async function setTemplateMapping(event: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.put(`/api/admin/templates/mappings/${event}`, body);
  return data;
}

export async function getTemplateNotifications(limit: number = 30): Promise<unknown> {
  const { data } = await client.get('/api/admin/templates/notifications', {
    params: { limit },
  });
  return data;
}

// Backend auto-discovers the platform WABA when waba_id is omitted (admin.js
// /templates/sync). Frontend no longer needs to pass it.
export async function syncTemplates(): Promise<unknown> {
  const { data } = await client.post('/api/admin/templates/sync', {});
  return data;
}

export async function seedTemplates(): Promise<unknown> {
  const { data } = await client.post('/api/admin/templates/seed');
  return data;
}

export async function testSendTemplate(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/admin/templates/test-send', body);
  return data;
}

// ── Restaurants ─────────────────────────────────────────────────────

export async function getAdminRestaurants(): Promise<AdminRestaurant[]> {
  const { data } = await client.get<AdminRestaurant[]>('/api/admin/restaurants');
  return data;
}

export async function updateAdminRestaurant(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.patch(`/api/admin/restaurants/${id}`, body);
  return data;
}

export async function setRestaurantCampaignCap(id: string, cap: number | null): Promise<unknown> {
  const { data } = await client.patch(
    `/api/admin/restaurants/${id}/campaign-cap`,
    { campaign_daily_cap: cap },
  );
  return data;
}

export async function deleteAdminRestaurant(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/admin/restaurants/${id}`);
  return data;
}

export async function getRestaurantStaffPinStatus(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/admin/restaurants/${id}/staff-pin/status`);
  return data;
}

export async function generateRestaurantStaffPin(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/restaurants/${id}/staff-pin/generate`);
  return data;
}

// ── Pincode serviceability ──────────────────────────────────────────

export async function getPincodes(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/pincodes', { params });
  return data;
}

export async function getPincodeStats(): Promise<unknown> {
  const { data } = await client.get('/api/admin/pincodes/stats');
  return data;
}

export async function togglePincode(pincode: string): Promise<unknown> {
  const { data } = await client.put(`/api/admin/pincodes/${encodeURIComponent(pincode)}/toggle`);
  return data;
}

export async function bulkUpdatePincodes(body: RequestBody): Promise<unknown> {
  const { data } = await client.put('/api/admin/pincodes/bulk', body);
  return data;
}

export async function importPincodes(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/admin/pincodes/import', body);
  return data;
}

export async function getPincodeCities(): Promise<unknown> {
  const { data } = await client.get('/api/admin/pincodes/cities');
  return data;
}

// Per-state aggregation for the collapsed accordion. One row per state,
// regardless of how many pincodes that state has. Drives the mount-time
// render so the accordion shows the FULL state list instead of just the
// states whose pincodes happen to fall in the first N rows of the
// flat-list endpoint.
export async function getPincodeStates(): Promise<import('../types').PincodeStateSummary[]> {
  const { data } = await client.get<import('../types').PincodeStateSummary[]>(
    '/api/admin/pincodes/states',
  );
  return data;
}

export async function bulkUpdateByCity(body: RequestBody): Promise<unknown> {
  const { data } = await client.put('/api/admin/pincodes/bulk-by-city', body);
  return data;
}

export async function bulkTogglePincodes(body: RequestBody): Promise<unknown> {
  const { data } = await client.patch('/api/admin/pincodes/bulk-toggle', body);
  return data;
}

// ── Applications ────────────────────────────────────────────────────

export async function getApplications(): Promise<unknown> {
  const { data } = await client.get('/api/admin/applications');
  return data;
}

export async function verifyApplicationGst(id: string, verified: boolean = true): Promise<unknown> {
  const { data } = await client.patch(`/api/admin/applications/${id}/verify-gst`, { verified });
  return data;
}

export async function verifyApplicationFssai(id: string, verified: boolean = true): Promise<unknown> {
  const { data } = await client.patch(`/api/admin/applications/${id}/verify-fssai`, { verified });
  return data;
}

export async function approveApplication(id: string, notes: string = ''): Promise<unknown> {
  const { data } = await client.patch(`/api/admin/applications/${id}/approve`, { notes });
  return data;
}

export async function rejectApplication(id: string, notes: string): Promise<unknown> {
  const { data } = await client.patch(`/api/admin/applications/${id}/reject`, { notes });
  return data;
}

// ── Directory ───────────────────────────────────────────────────────

export async function getDirectoryStats(): Promise<unknown> {
  const { data } = await client.get('/api/admin/directory/stats');
  return data;
}

export async function getDirectoryListings(params: QueryParams = { limit: 100 }): Promise<unknown> {
  const { data } = await client.get('/api/admin/directory/listings', { params });
  return data;
}

export async function toggleDirectoryListing(id: string, isActive: boolean): Promise<unknown> {
  const { data } = await client.patch(`/api/admin/directory/listings/${id}/toggle`, { isActive });
  return data;
}

export async function syncAllDirectory(): Promise<unknown> {
  const { data } = await client.post('/api/admin/directory/sync-all');
  return data;
}

// ── Orders ──────────────────────────────────────────────────────────

export async function getAdminOrders(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/orders', { params });
  return data;
}

export async function reportFakeDeliveryAdmin(id: string): Promise<{ success: boolean; issue_id: string }> {
  const { data } = await client.post(`/api/admin/orders/${id}/report-fake-delivery`);
  return data as { success: boolean; issue_id: string };
}

export async function getAdminOrdersWithIssues(): Promise<unknown> {
  const { data } = await client.get('/api/admin/orders/with-issues');
  return data;
}

// ── Customers ───────────────────────────────────────────────────────

export async function getAdminCustomers(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/customers', { params });
  return data;
}

export async function getAdminCustomerIdentity(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/customers/identity', { params });
  return data;
}

// ── Issues ──────────────────────────────────────────────────────────

export async function getAdminIssueStats(params: QueryParams = { admin_queue: 'true' }): Promise<unknown> {
  const { data } = await client.get('/api/admin/issues/stats', { params });
  return data;
}

export async function getAdminIssues(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/issues', { params });
  return data;
}

export async function getAdminIssue(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/admin/issues/${id}`);
  return data;
}

export async function setAdminIssueStatus(id: string, status: string): Promise<unknown> {
  const { data } = await client.put(`/api/admin/issues/${id}/status`, { status });
  return data;
}

export async function reopenAdminIssue(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/issues/${id}/reopen`, {});
  return data;
}

export async function postAdminIssueMessage(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.post(`/api/admin/issues/${id}/message`, body);
  return data;
}

export async function resolveAdminIssue(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.post(`/api/admin/issues/${id}/resolve`, body);
  return data;
}

export async function refundAdminIssue(id: string, amountRs?: number): Promise<unknown> {
  const body: RequestBody = amountRs ? { amount_rs: amountRs } : {};
  const { data } = await client.post(`/api/admin/issues/${id}/refund`, body);
  return data;
}

export async function flagIssueSettlement(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.post(`/api/admin/issues/${id}/flag-settlement`, body);
  return data;
}

// ── Referrals ───────────────────────────────────────────────────────

export async function getReferralStats(): Promise<unknown> {
  const { data } = await client.get('/api/admin/referrals/stats');
  return data;
}

export async function getReferrals(): Promise<unknown> {
  const { data } = await client.get('/api/admin/referrals');
  return data;
}

export async function createReferral(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/admin/referrals', body);
  return data;
}

export async function getReferralLinkRequests(): Promise<unknown> {
  const { data } = await client.get('/api/admin/referral-link-requests');
  return data;
}

export async function resolveReferralLinkRequest(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/referral-link-requests/${id}/resolve`);
  return data;
}

export async function createReferralLink(restaurantId: string, campaignName?: string | null): Promise<unknown> {
  const body: RequestBody = { restaurant_id: restaurantId };
  if (campaignName) body.campaign_name = campaignName;
  const { data } = await client.post('/api/admin/referrals/links', body);
  return data;
}

// ── Settlements ─────────────────────────────────────────────────────

export async function getSettlementStats(): Promise<unknown> {
  const { data } = await client.get('/api/admin/settlements/stats');
  return data;
}

export async function getSettlements(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/settlements', { params });
  return data;
}

export async function getSettlementMetaBreakdown(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/admin/settlements/${id}/meta-breakdown`);
  return data;
}

export async function downloadSettlementBlob(id: string): Promise<BlobDownload> {
  const res: AxiosResponse<Blob> = await client.get<Blob>(`/api/admin/settlements/${id}/download`, {
    responseType: 'blob',
  });
  return { blob: res.data, headers: res.headers };
}

export async function runSettlement(): Promise<unknown> {
  const { data } = await client.post('/api/admin/run-settlement');
  return data;
}

// ── Financials ──────────────────────────────────────────────────────

export async function getFinancialsOverview(period: string = '30d'): Promise<unknown> {
  const { data } = await client.get('/api/admin/financials/overview', { params: { period } });
  return data;
}

export async function getFinancialsSettlements(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/financials/settlements', { params });
  return data;
}

export async function getFinancialsSettlement(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/admin/financials/settlements/${id}`);
  return data;
}

export async function payFinancialsSettlement(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/financials/settlements/${id}/pay`);
  return data;
}

export async function getFinancialsPayments(params: QueryParams = { page: 1, limit: 20 }): Promise<unknown> {
  const { data } = await client.get('/api/admin/financials/payments', { params });
  return data;
}

export async function getFinancialsRefunds(params: QueryParams = { page: 1, limit: 20 }): Promise<unknown> {
  const { data } = await client.get('/api/admin/financials/refunds', { params });
  return data;
}

export async function getFinancialsTax(period: string = '30d'): Promise<unknown> {
  const { data } = await client.get('/api/admin/financials/tax', { params: { period } });
  return data;
}

export async function downloadTdsReportBlob(period: string = '30d'): Promise<BlobDownload> {
  const res: AxiosResponse<Blob> = await client.get<Blob>('/api/admin/financials/tax/tds-report', {
    params: { period },
    responseType: 'blob',
  });
  return { blob: res.data, headers: res.headers };
}

export async function downloadGstr1Blob(period: string = '30d'): Promise<BlobDownload> {
  const res: AxiosResponse<Blob> = await client.get<Blob>('/api/admin/financials/tax/gstr1', {
    params: { period },
    responseType: 'blob',
  });
  return { blob: res.data, headers: res.headers };
}

// ── Coupon templates ────────────────────────────────────────────────

export async function getCouponTemplates(restaurantId: string): Promise<unknown> {
  const { data } = await client.get('/api/admin/coupon-templates', {
    params: { restaurant_id: restaurantId },
  });
  return data;
}

export async function createCouponTemplate(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/admin/coupon-templates', body);
  return data;
}

// ── Coupon codes ────────────────────────────────────────────────────

export async function getAdminCoupons(restaurantId: string): Promise<unknown> {
  const { data } = await client.get('/api/admin/coupons', {
    params: { restaurant_id: restaurantId },
  });
  return data;
}

export async function createAdminCoupon(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/admin/coupons', body);
  return data;
}

export async function patchAdminCoupon(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.patch(`/api/admin/coupons/${id}`, body);
  return data;
}

// ── Marketing messages ──────────────────────────────────────────────

export async function getAdminMarketingMessages(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/marketing-messages', { params });
  return data;
}

// ── Analytics ───────────────────────────────────────────────────────

export async function getAnalyticsCities(): Promise<string[]> {
  const { data } = await client.get<string[]>('/api/admin/analytics/filters/cities');
  return data;
}

export async function getAnalyticsAreas(city: string): Promise<string[]> {
  const { data } = await client.get<string[]>('/api/admin/analytics/filters/areas', {
    params: { city },
  });
  return data;
}

export async function getAnalyticsOverview(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/overview', { params });
  return data;
}

export async function getAnalyticsTimeseries(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/orders/timeseries', { params });
  return data;
}

export async function getAnalyticsByStatus(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/orders/by-status', { params });
  return data;
}

export async function getAnalyticsByHour(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/orders/by-hour', { params });
  return data;
}

export async function getAnalyticsByDay(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/orders/by-day', { params });
  return data;
}

export async function getAnalyticsGeographicCities(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/geographic/cities', { params });
  return data;
}

export async function getAnalyticsRestaurantRanking(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/restaurants/ranking', { params });
  return data;
}

export async function getAnalyticsCustomerSegments(): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/customers/segments');
  return data;
}

export async function getAnalyticsDeliveryPerformance(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/delivery/performance', { params });
  return data;
}

export async function getAnalyticsCustomersOverview(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/customers/overview', { params });
  return data;
}

export async function getAnalyticsFunnel(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/analytics/funnel', { params });
  return data;
}

// ── Webhook logs ────────────────────────────────────────────────────

export async function getAdminLogs(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/logs', { params });
  return data;
}

export async function getAdminLog(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/admin/logs/${id}`);
  return data;
}

// ── Dead letter queue ───────────────────────────────────────────────

export async function getDlqStats(): Promise<unknown> {
  const { data } = await client.get('/api/admin/webhook-retry/stats');
  return data;
}

export async function getDlq(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/dlq', { params });
  return data;
}

export async function retryDlq(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/dlq/${id}/retry`);
  return data;
}

export async function dismissDlq(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/dlq/${id}/dismiss`);
  return data;
}

// ── Catalog sync logs + Meta alerts ─────────────────────────────────

export async function getSyncLogs(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/sync-logs', { params });
  return data;
}

export async function getMetaAlerts(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/meta-alerts', { params });
  return data;
}

export async function resolveMetaAlert(id: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/meta-alerts/${id}/resolve`);
  return data;
}

// ── Activity monitor ────────────────────────────────────────────────

export async function getActivityStats(): Promise<unknown> {
  const { data } = await client.get('/api/admin/activity/stats');
  return data;
}

export async function getActivityFeed(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/activity', { params });
  return data;
}

export async function getWebhooksLive(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/webhooks/live', { params });
  return data;
}

export async function getWebhookDetail(id: string): Promise<unknown> {
  const { data } = await client.get(`/api/admin/webhooks/${id}`);
  return data;
}

export async function getActivityErrors(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/activity/errors', { params });
  return data;
}

export async function resolveActivity(id: string): Promise<unknown> {
  const { data } = await client.put(`/api/admin/activity/${id}/resolve`);
  return data;
}

export async function getActivityForRestaurant(id: string, params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get(`/api/admin/activity/restaurant/${id}`, { params });
  return data;
}

// ── Abuse protection ────────────────────────────────────────────────

export async function getRateLimitStats(): Promise<unknown> {
  const { data } = await client.get('/api/admin/rate-limit/stats');
  return data;
}

export async function getBlockedPhones(): Promise<unknown> {
  const { data } = await client.get('/api/admin/blocked-phones');
  return data;
}

export async function blockPhone(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/admin/blocked-phones', body);
  return data;
}

export async function unblockPhone(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/admin/blocked-phones/${id}`);
  return data;
}

// ── Admin users ─────────────────────────────────────────────────────

export async function getAdminUsers(): Promise<unknown> {
  const { data } = await client.get('/api/admin/users');
  return data;
}

export async function updateAdminUser(id: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.put(`/api/admin/users/${id}`, body);
  return data;
}

// ── Usernames ───────────────────────────────────────────────────────

export async function getUsernames(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/usernames', { params });
  return data;
}

export async function checkUsername(waid: string, username: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/usernames/${waid}/check`, { username });
  return data;
}

export async function setUsernameTarget(waid: string, username: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/usernames/${waid}/set-target`, { username });
  return data;
}

export async function confirmUsername(waid: string, username: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/usernames/${waid}/confirm`, { username });
  return data;
}

export async function syncUsername(waid: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/usernames/${waid}/sync`);
  return data;
}

export async function releaseUsername(waid: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/usernames/${waid}/release`);
  return data;
}

export async function suggestUsernames(waid: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/usernames/${waid}/suggest`);
  return data;
}

export async function autoSuggestUsernamesAll(): Promise<unknown> {
  const { data } = await client.post('/api/admin/usernames/auto-suggest');
  return data;
}

export async function syncUsernamesAll(): Promise<unknown> {
  const { data } = await client.post('/api/admin/usernames/sync-all');
  return data;
}

// ── Logistics analytics ─────────────────────────────────────────────

export async function getLogisticsAnalytics(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/logistics/analytics', { params });
  return data;
}

export async function getAdminBranches(restaurantId: string): Promise<unknown> {
  const { data } = await client.get('/api/admin/branches', {
    params: { restaurant_id: restaurantId },
  });
  return data;
}

// ── Overview ────────────────────────────────────────────────────────

export async function getAdminStats(): Promise<unknown> {
  const { data } = await client.get('/api/admin/stats');
  return data;
}

export async function getAdminRatingStats(): Promise<unknown> {
  const { data } = await client.get('/api/admin/ratings/stats');
  return data;
}

export async function getAdminDeliveryStats(): Promise<unknown> {
  const { data } = await client.get('/api/admin/delivery/stats');
  return data;
}

export async function getAdminAlerts(): Promise<unknown> {
  const { data } = await client.get('/api/admin/alerts');
  return data;
}

// ── Campaign templates ──────────────────────────────────────────────

export async function getAdminCampaignTemplates(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/campaign-templates', { params });
  return data;
}

export async function createCampaignTemplate(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/admin/campaign-templates', body);
  return data;
}

export async function updateCampaignTemplate(templateId: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.put(`/api/admin/campaign-templates/${encodeURIComponent(templateId)}`, body);
  return data;
}

export async function deleteCampaignTemplate(templateId: string): Promise<unknown> {
  const { data } = await client.delete(`/api/admin/campaign-templates/${encodeURIComponent(templateId)}`);
  return data;
}

export async function activateCampaignTemplate(templateId: string): Promise<unknown> {
  const { data } = await client.post(`/api/admin/campaign-templates/${encodeURIComponent(templateId)}/activate`);
  return data;
}

export async function updateCampaignTemplateApproval(templateId: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.patch(
    `/api/admin/campaign-templates/${encodeURIComponent(templateId)}/approval`,
    body,
  );
  return data;
}

export async function getMarketingCampaignsOverview(): Promise<unknown> {
  const { data } = await client.get('/api/admin/marketing-campaigns/overview');
  return data;
}

// ── Festival calendar ───────────────────────────────────────────────

export async function getAdminFestivals(params: QueryParams = {}): Promise<unknown> {
  const { data } = await client.get('/api/admin/festivals', { params });
  return data;
}

export async function createFestival(body: RequestBody): Promise<unknown> {
  const { data } = await client.post('/api/admin/festivals', body);
  return data;
}

export async function updateFestival(slug: string, body: RequestBody): Promise<unknown> {
  const { data } = await client.put(`/api/admin/festivals/${encodeURIComponent(slug)}`, body);
  return data;
}

export async function toggleFestival(slug: string): Promise<unknown> {
  const { data } = await client.patch(`/api/admin/festivals/${encodeURIComponent(slug)}/toggle`);
  return data;
}

export async function seedFestivalCalendarAdmin(years?: number[]): Promise<unknown> {
  const { data } = await client.post('/api/admin/festivals/seed', years ? { years } : {});
  return data;
}

// ── Platform Marketing Analytics ────────────────────────────────────

export async function getPlatformMarketingSnapshot(period: string = '30d'): Promise<unknown> {
  const { data } = await client.get('/api/admin/platform-marketing/snapshot', { params: { period } });
  return data;
}

// ── Admin Fees Overview ─────────────────────────────────────────────

export async function getAdminFeesSummary(from?: string, to?: string): Promise<AdminFeesSummary> {
  const params: QueryParams = {};
  if (from) params.from = from;
  if (to) params.to = to;
  const { data } = await client.get<AdminFeesSummary>('/api/admin/fees/summary', { params });
  return data;
}

export async function getAdminRestaurantFaults(
  from?: string,
  to?: string,
  restaurantId?: string,
): Promise<AdminRestaurantFaultFee[]> {
  const params: QueryParams = {};
  if (from) params.from = from;
  if (to) params.to = to;
  if (restaurantId) params.restaurantId = restaurantId;
  const { data } = await client.get<AdminRestaurantFaultFee[]>(
    '/api/admin/fees/restaurant-faults',
    { params },
  );
  return data;
}

export async function getAdminPlatformAbsorbed(
  from?: string,
  to?: string,
): Promise<AdminPlatformAbsorbedFee[]> {
  const params: QueryParams = {};
  if (from) params.from = from;
  if (to) params.to = to;
  const { data } = await client.get<AdminPlatformAbsorbedFee[]>(
    '/api/admin/fees/platform-absorbed',
    { params },
  );
  return data;
}

// ── Admin ↔ Restaurant DM thread ────────────────────────────────
// Calling getAdminMessageThread() also marks the restaurant→admin
// rows in this thread as read server-side, clearing the admin's
// unread badge for that conversation.
export async function sendAdminMessage(
  restaurantId: string,
  message: string,
): Promise<import('../types').AdminRestaurantMessage> {
  const { data } = await client.post<import('../types').AdminRestaurantMessage>(
    '/api/admin/messages',
    { restaurantId, message },
  );
  return data;
}

export async function getAdminMessageThread(
  restaurantId: string,
): Promise<import('../types').AdminRestaurantMessagesResponse> {
  const { data } = await client.get<import('../types').AdminRestaurantMessagesResponse>(
    `/api/admin/messages/${encodeURIComponent(restaurantId)}`,
  );
  return data;
}
