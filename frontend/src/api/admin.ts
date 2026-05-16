import client from '../lib/apiClient';
import type { AxiosResponse, RawAxiosResponseHeaders, AxiosResponseHeaders } from 'axios';
import type {
  AdminFeesSummary,
  AdminPlatformAbsorbedFee,
  AdminRestaurant,
  AdminRestaurantFaultFee,
  AdminUser,
  AuthResponse,
  AuthUser,
  CaptainLogListResponse,
  CityAnalytics,
  CityDoc,
  CityInterestLeaderboard,
  CityListing,
  CityWabaMeta,
  CustomerPersona,
  ListingAnalytics,
  MetaPhoneNumber,
  PersonaDistribution,
  PersonaQueryParams,
  PersonaQueryResult,
  QueryParams,
  RequestBody,
  TagTaxonomy,
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

// RBAC profile — returns the admin_users document for the current
// session. Distinct from getAdminMe() above (which hits the legacy
// /api/admin/auth/me login-shape endpoint); this one is the source of
// truth for role + cities + is_active gating in the dashboard.
export async function getAdminProfile(): Promise<AdminUser> {
  const { data } = await client.get<AdminUser>('/api/admin/me');
  return data;
}

// ── Cities + RBAC management ────────────────────────────────────────

export async function getCities(): Promise<CityDoc[]> {
  const { data } = await client.get<CityDoc[]>('/api/admin/cities');
  return data;
}

export async function createCity(body: {
  name: string;
  slug?: string;
  phone_number_id: string;
  waba_id?: string | null;
  display_name?: string;
  areas?: string[];
}): Promise<CityDoc> {
  const { data } = await client.post<CityDoc>('/api/admin/cities', body);
  return data;
}

export async function getCityDetail(slug: string): Promise<CityDoc> {
  const { data } = await client.get<CityDoc>(`/api/admin/cities/${encodeURIComponent(slug)}`);
  return data;
}

export async function updateCity(
  slug: string,
  body: Partial<Pick<CityDoc, 'name' | 'display_name' | 'status' | 'areas' | 'phone_number_id' | 'waba_id' | 'editorial_config'>>,
): Promise<CityDoc> {
  const { data } = await client.patch<CityDoc>(`/api/admin/cities/${encodeURIComponent(slug)}`, body);
  return data;
}

export async function getMetaPhoneNumbers(): Promise<MetaPhoneNumber[]> {
  const { data } = await client.get<MetaPhoneNumber[]>('/api/admin/cities/meta-phone-numbers');
  return data;
}

// Forces a fresh fetch of the city's WABA phone-number projection from
// the Meta Graph API and persists it on the city doc under `meta`.
// Returns the refreshed projection (display_phone_number, verified_name,
// quality_rating, status, refreshed_at).
export async function refreshCityWabaStatus(slug: string): Promise<CityWabaMeta> {
  const { data } = await client.post<CityWabaMeta>(
    `/api/admin/cities/${encodeURIComponent(slug)}/refresh-waba-status`,
  );
  return data;
}

export interface CityListingListParams {
  status?: string;
  fulfillment_mode?: string;
  business_type?: string;
  research_status?: string;
  area?: string;
  page?: number;
  limit?: number;
}

export interface CityListingListResponse {
  total: number;
  page: number;
  limit: number;
  results: CityListing[];
}

export async function getCityListings(
  slug: string,
  params: CityListingListParams = {},
): Promise<CityListingListResponse> {
  const { data } = await client.get<CityListingListResponse>(
    `/api/admin/cities/${encodeURIComponent(slug)}/listings`,
    { params },
  );
  return data;
}

export async function getCityListingDetail(
  slug: string,
  listingId: string,
): Promise<CityListing & { latest_snapshot: unknown }> {
  const { data } = await client.get<CityListing & { latest_snapshot: unknown }>(
    `/api/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(listingId)}`,
  );
  return data;
}

export interface MenuSnapshotDetail {
  _id: string;
  listing_id: string;
  city_id: string;
  source: string;
  sources_cited: string[];
  raw_extracted_texts?: Array<{ url: string; text: string }>;
  extracted_items?: unknown[];
  tags: Record<string, unknown> | null;
  confidence_scores: Record<string, number> | null;
  status: string;
  is_live: boolean;
  created_at: string;
  schema_version?: number;
}

export async function getCityListingSnapshotDetail(
  slug: string,
  listingId: string,
  snapshotId: string,
): Promise<MenuSnapshotDetail> {
  const { data } = await client.get<MenuSnapshotDetail>(
    `/api/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(listingId)}/snapshots/${encodeURIComponent(snapshotId)}`,
  );
  return data;
}

export async function getAdminTaxonomy(): Promise<TagTaxonomy> {
  const { data } = await client.get<TagTaxonomy>('/api/admin/taxonomy');
  return data;
}

// ── Captain Inbound Logs ────────────────────────────────────────────

export interface CaptainLogQuery {
  city_id?: string;
  had_error?: 'true' | 'false';
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export async function getCaptainLogs(params: CaptainLogQuery = {}): Promise<CaptainLogListResponse> {
  const { data } = await client.get<CaptainLogListResponse>('/api/admin/captain-logs', { params });
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

// Combined commission summary + daily timeseries for the admin charts.
// Backend: GET /api/admin/referrals/analytics (admin.js).
export interface ReferralAnalyticsDay {
  date: string;          // 'YYYY-MM-DD' (IST)
  created: number;
  converted: number;
  expired: number;
  commission_rs: number;
}
export interface ReferralAnalyticsSummary {
  total_referrals: number;
  by_status: { active?: number; converted?: number; expired?: number; superseded?: number; reversed?: number };
  total_attributed_orders: number;
  total_attributed_subtotal: number;
  commission: { pending: number; confirmed: number; reversed: number; settled: number; net_total: number };
  commission_percent: number;
}
export interface ReferralAnalyticsResponse {
  summary: ReferralAnalyticsSummary;
  daily: ReferralAnalyticsDay[];
}

export async function getReferralAnalytics(params: { from: string; to: string; restaurantId?: string }): Promise<ReferralAnalyticsResponse> {
  const query: Record<string, string> = { from: params.from, to: params.to };
  if (params.restaurantId) query.restaurant_id = params.restaurantId;
  const { data } = await client.get<ReferralAnalyticsResponse>('/api/admin/referrals/analytics', { params: query });
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

// Mark a pending_manual_payout settlement as paid. Backend expects
// { payout_id, external_reference } — external_reference is the bank UTR.
// (POST /api/admin/settlements/confirm — route predates this UI.)
export async function confirmSettlementPayout(
  payoutId: string,
  externalReference: string,
): Promise<unknown> {
  const { data } = await client.post('/api/admin/settlements/confirm', {
    payout_id: payoutId,
    external_reference: externalReference,
  });
  return data;
}

export async function downloadSettlementBlob(id: string): Promise<BlobDownload> {
  const res: AxiosResponse<Blob> = await client.get<Blob>(`/api/admin/settlements/${id}/download`, {
    responseType: 'blob',
  });
  return { blob: res.data, headers: res.headers };
}

// (Removed) runSettlement() → POST /api/admin/run-settlement. The legacy
// cross-tenant trigger was deleted; auto-settlement runs Mon+Thu server-side.

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

export async function deleteAdminCoupon(id: string): Promise<unknown> {
  const { data } = await client.delete(`/api/admin/coupons/${id}`);
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

export async function approveBranch(branchId: string, notes?: string): Promise<unknown> {
  const { data } = await client.post(
    `/api/admin/branches/${branchId}/approve`,
    { notes },
  );
  return data;
}

export async function bulkApproveBranches(branchIds: string[]): Promise<unknown> {
  const { data } = await client.post('/api/admin/branches/bulk-approve', {
    branch_ids: branchIds,
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

// ── Owner Push Alerts (platform-level prefs) ─────────────────────────
// Backed by platform_settings._id = 'owner_push_prefs'. Drives the four
// owner-mobile push channels surfaced on the staff app.

export type OwnerPushPrefs = {
  new_order: boolean;
  settlement_paid: boolean;
  branch_paused: boolean;
  daily_summary: boolean;
};

export async function getOwnerPushPrefs(): Promise<{ prefs: OwnerPushPrefs }> {
  const { data } = await client.get<{ prefs: OwnerPushPrefs }>('/api/admin/owner-notifications');
  return data;
}

export async function updateOwnerPushPrefs(
  prefs: Partial<OwnerPushPrefs>,
): Promise<{ ok: boolean; prefs: OwnerPushPrefs }> {
  const { data } = await client.patch<{ ok: boolean; prefs: OwnerPushPrefs }>(
    '/api/admin/owner-notifications',
    prefs,
  );
  return data;
}

// ── Platform: WhatsApp Marketing Pricing ────────────────────────────
// Single platform-wide markup multiplier applied to Meta's raw send
// rate. Backed by platform_settings._id = 'wa_pricing'. Default 1.0
// (pass-through); admin tunes upward to add a per-message platform
// margin. Read by services/marketingCampaigns.sendCampaign at debit
// time and by routes/marketingCampaigns POST /create at estimate time.

export interface PlatformPricing {
  markup_multiplier: number;
  updated_at: string | null;
  updated_by: string | null;
}

export async function getPlatformPricing(): Promise<PlatformPricing> {
  const { data } = await client.get<PlatformPricing>('/api/admin/platform/pricing');
  return data;
}

export async function updatePlatformPricing(
  body: { markup_multiplier: number },
): Promise<PlatformPricing> {
  const { data } = await client.patch<PlatformPricing>(
    '/api/admin/platform/pricing',
    body,
  );
  return data;
}

// ── Captain analytics ──────────────────────────────────────────────
// City-level rollups (activity stats + interest leaderboard) and a
// per-listing funnel + 14-day daily time series. The `days` query
// parameter is optional — omit it so the backend's default window
// (7 days) takes effect.

export async function getCityAnalytics(slug: string, days?: number): Promise<CityAnalytics> {
  const params: Record<string, number> = {};
  if (typeof days === 'number') params.days = days;
  const { data } = await client.get<CityAnalytics>(`/api/admin/cities/${encodeURIComponent(slug)}/analytics`, { params });
  return data;
}

export async function getCityInterestLeaderboard(slug: string, days?: number): Promise<CityInterestLeaderboard> {
  const params: Record<string, number> = {};
  if (typeof days === 'number') params.days = days;
  const { data } = await client.get<CityInterestLeaderboard>(`/api/admin/cities/${encodeURIComponent(slug)}/interest-leaderboard`, { params });
  return data;
}

// Trigger a browser download of the captain leaderboard CSV. Receives
// the response as a Blob, constructs a temporary anchor with
// download={filename}, clicks it, then revokes the object URL.
// Returns the filename used so callers can showToast it if desired.
export async function exportLeaderboard(slug: string, days?: number): Promise<string> {
  const params: Record<string, number> = {};
  if (typeof days === 'number') params.days = days;
  const resp = await client.get<Blob>(
    `/api/admin/cities/${encodeURIComponent(slug)}/interest-leaderboard/export`,
    { params, responseType: 'blob' },
  );
  const blob = resp.data;
  const today = new Date().toISOString().slice(0, 10);
  const filename = `captain-leads-${slug}-${today}.csv`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return filename;
}

export async function getListingAnalytics(slug: string, listingId: string, days?: number): Promise<ListingAnalytics> {
  const params: Record<string, number> = {};
  if (typeof days === 'number') params.days = days;
  const { data } = await client.get<ListingAnalytics>(`/api/admin/cities/${encodeURIComponent(slug)}/listings/${encodeURIComponent(listingId)}/analytics`, { params });
  return data;
}

// ── Customer Personas ──────────────────────────────────────────────
// Read + rebuild endpoints for the customer persona document. Backend
// gates the routes to super_admin / city_ops and pre-masks PII before
// returning sample rows from the audience query.

export async function getCustomerPersona(
  customerId: string,
): Promise<{ customer: { id: string; name?: string; phone?: string }; persona: CustomerPersona | null }> {
  const { data } = await client.get<{ customer: { id: string; name?: string; phone?: string }; persona: CustomerPersona | null }>(
    `/api/admin/personas/${encodeURIComponent(customerId)}`,
  );
  return data;
}

export async function rebuildCustomerPersona(customerId: string): Promise<CustomerPersona> {
  const { data } = await client.post<CustomerPersona>(
    `/api/admin/personas/${encodeURIComponent(customerId)}/rebuild`,
  );
  return data;
}

export async function rebuildPersonasBatch(
  body: { city_id?: string; since?: string },
): Promise<{ queued: number }> {
  const { data } = await client.post<{ queued: number }>('/api/admin/personas/rebuild-batch', body);
  return data;
}

export async function queryPersonas(params: PersonaQueryParams): Promise<PersonaQueryResult> {
  // Backend parses array params as CSV — keep encoding here so callers
  // pass a plain object and don't have to think about transport.
  const searchParams = new URLSearchParams();
  if (params.city_id) searchParams.set('city_id', params.city_id);
  if (params.cuisine) searchParams.set('cuisine', params.cuisine);
  if (params.min_cuisine_score != null) searchParams.set('min_cuisine_score', String(params.min_cuisine_score));
  (['price_sensitivity', 'order_frequency', 'veg_strictness', 'discovery_stage', 'area'] as const).forEach((k) => {
    const v = params[k];
    if (v && v.length) searchParams.set(k, v.join(','));
  });
  const { data } = await client.get<PersonaQueryResult>(
    `/api/admin/personas/query?${searchParams.toString()}`,
  );
  return data;
}

export async function getPersonaDistribution(cityId?: string): Promise<PersonaDistribution> {
  const qs = cityId ? `?city_id=${encodeURIComponent(cityId)}` : '';
  const { data } = await client.get<PersonaDistribution>(`/api/admin/personas/distribution${qs}`);
  return data;
}

// ── Captain persona (super_admin only) ─────────────────────────────
// Single platform-wide LLM system prompt template. Backend stores the
// raw template (with the {city_name} placeholder) in
// platform_settings._id='captain_persona' and substitutes the actual
// city name at runtime.

export async function getCaptainPersona(): Promise<{ persona: string }> {
  const { data } = await client.get<{ persona: string }>('/api/admin/captain-persona');
  return data;
}

export async function updateCaptainPersona(persona: string): Promise<{ persona: string }> {
  const { data } = await client.patch<{ persona: string }>('/api/admin/captain-persona', { persona });
  return data;
}
