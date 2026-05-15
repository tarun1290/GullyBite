// Shared types for the GullyBite Next.js app.
//
// Field sets are derived from the JS API source files
// (frontend/src/api/*.js) and from the React components that consume the
// returned data (OrderCard.jsx, OverviewTab.jsx, BranchFormModal.jsx,
// MenuEditorSection.jsx). For shapes whose full structure is not pinned
// down by source, we use Record<string, unknown> so callers can still
// index safely without falling back to the unsound escape hatch.

// ── Generic helpers ─────────────────────────────────────────────────

export type Json = string | number | boolean | null | { [k: string]: Json } | Json[];

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export type RequestBody = Record<string, unknown>;

export interface PaginatedResponse<T> {
  items: T[];
  total?: number;
  pages?: number;
  page?: number;
  has_more?: boolean;
}

// ── Auth ────────────────────────────────────────────────────────────

export type UserRole = 'super_admin' | 'admin' | 'owner' | 'manager' | 'staff' | string;

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
  role: UserRole;
  restaurant_id?: string;
  brand_name?: string;
  phone?: string;
  branch_ids?: string[];
  is_active?: boolean;
  last_login_at?: string;
  created_at?: string;
  customer_full_phone?: boolean;
  approval_status?: string;
  onboarding_step?: number;
  owner_name?: string;
  city?: string;
  restaurant_type?: 'veg' | 'non_veg' | 'both';
  gst_number?: string;
  fssai_license?: string;
  [k: string]: unknown;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

// RBAC admin user shape returned by GET /api/admin/me. Distinct from
// AuthUser (which carries the restaurant-side session); fields mirror
// the admin_users collection projection minus password_hash.
export interface AdminUser {
  _id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'city_ops' | 'sales';
  cities: string[];
  is_active: boolean;
}

// ── Cities + RBAC managed catalog ───────────────────────────────────
// CityDoc mirrors the `cities` collection projection returned by
// GET /api/admin/cities (list) and /api/admin/cities/:slug (detail).
// Cities own a WABA phone number and a denormalised area list, plus an
// optional editorial_config block used by the consumer surfaces.
export interface CityDoc {
  _id: string;
  name: string;
  slug: string;
  display_name: string;
  status: 'setup' | 'active' | 'paused' | 'deleted';
  phone_number_id: string;
  waba_id: string | null;
  areas: string[];
  listing_count?: number;
  editorial_config?: {
    hero_banner_url: string | null;
    featured_listings: string[];
    curated_lists: unknown[];
  };
  meta?: {
    display_phone_number?: string | null;
    verified_name?: string | null;
    quality_rating?: string | null;
    status?: string | null;
    refreshed_at?: string | null;
  };
  created_at: string;
}

// CityWabaMeta — response from POST /api/admin/cities/:slug/refresh-waba-status.
// Mirrors the persisted `meta` sub-document but with the post-refresh
// guarantee that `refreshed_at` is always present.
export interface CityWabaMeta {
  display_phone_number: string | null;
  verified_name: string | null;
  quality_rating: string | null;
  status: string | null;
  refreshed_at: string;
}

// CityListing — one row per restaurant/cloud-kitchen registered under
// a city. Drives the per-city listings dashboard + the research queue.
export interface CityListing {
  _id: string;
  name: string;
  slug: string;
  area: string;
  business_type: 'physical' | 'cloud_kitchen';
  status: 'draft' | 'active' | 'paused' | 'deleted';
  fulfillment_mode: 'notify_only' | 'handoff';
  research_status: 'pending' | 'in_progress' | 'needs_review' | 'complete' | 'research_failed' | 'no_content_found';
  // Captain-listing edit fields (PATCH /captain-listing). Set at the top
  // level of the doc — distinct from `tags`, which holds the curated
  // taxonomy bag (cuisine_primary, price_band, etc.).
  description?: string | null;
  website_url?: string | null;
  phone_number?: string | null;
  delivery_zones?: string[];
  // Short, customer-facing promotional blurbs surfaced via the captain
  // (e.g. "20% off on weekdays"). Capped at 5 entries × 80 chars by the
  // PATCH validator. Optional because legacy docs may not have it.
  offers?: string[];
  tags: Record<string, unknown> | null;
  latest_snapshot_id: string | null;
  last_researched_at: string | null;
  editorial_boost_score: number;
  sponsored_until: string | null;
  city_id: string;
  created_at: string;
}

// TaxonomyPriceBand — single bucket inside TagTaxonomy.price_bands.
// max_rs is nullable for the open-ended top band.
export interface TaxonomyPriceBand {
  key: string;
  label: string;
  min_rs: number;
  max_rs: number | null;
}

// TagTaxonomy — singleton document (_id: 'tag_taxonomy') that
// enumerates the controlled vocabulary used by the listing researcher
// + the consumer filters. Versioned so callers can detect updates.
export interface TagTaxonomy {
  _id: 'tag_taxonomy';
  version: number;
  cuisine_primary: string[];
  price_bands: TaxonomyPriceBand[];
  veg_status_options: string[];
  vibe_tags: string[];
  meal_contexts: string[];
  service_modes: string[];
  dietary_flags: string[];
  specialty_tags_approved: string[];
  hyderabad_areas: string[];
}

// MetaPhoneNumber — projection of a WABA phone number returned by the
// Meta Graph API and exposed to the admin via
// GET /api/admin/cities/meta-phone-numbers. Used in the Create City
// modal to assign a phone to a new city; the backend sets
// assigned_to_city on numbers already bound to a city slug.
export interface MetaPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating?: string;
  assigned_to_city: string | null;
}

// Captain analytics — city-level summary. Drives the activity stats
// shown on the city detail page below the listings grid.
export interface CityAnalytics {
  days: number;
  listings: {
    by_research_status: Record<string, number>;
    by_status: Record<string, number>;
  };
  signals: Record<string, number>;
  sessions: { total: number; new_in_window: number };
}

// One row in the interest leaderboard. Top 20 listings ranked by
// weighted action score. unfulfilled_notify_count drives the
// "X waiting" badge — surfaces warm demand for the sales pitch.
export interface LeaderboardEntry {
  rank: number;
  listing_id: string;
  name: string;
  area: string | null;
  status: string | null;
  listing_card_shown: number;
  menu_viewed: number;
  tapped_notify_me: number;
  tapped_order_handoff: number;
  gbref_link_generated: number;
  gbref_order_attributed: number;
  interest_score: number;
  unfulfilled_notify_count: number;
}

export interface CityInterestLeaderboard {
  days: number;
  results: LeaderboardEntry[];
}

// ── Captain (restaurant-side) ─────────────────────────────────
// Surfaces consumed by /dashboard/captain-listing. Driven by
// /api/restaurant/captain/{listing,suggested}. The listing endpoint
// returns a discriminated union (linked vs not); when linked it also
// rolls up notify_intents totals so the page can render a "X waiting"
// callout without a second round-trip.
export interface CaptainListingStatus {
  linked: boolean;
  listing?: CityListing & { id: string };
  city?: { name: string; slug: string } | null;
  notify_counts?: { total: number; unfulfilled: number; fulfilled: number };
}

export interface CaptainSuggestion extends CityListing {
  id: string;
  city: { name: string; slug: string } | null;
  unfulfilled_notify_count: number;
}

export interface CaptainLogEntry {
  _id?: string;
  id?: string;
  city_id: string | null;
  city_name: string | null;
  customer_id: string | null;
  phone_hash: string | null;
  message_type: string;
  session_state_before: string;
  session_state_after: string;
  had_error: boolean;
  ts: string;
}

export interface CaptainLogListResponse {
  total: number;
  page: number;
  limit: number;
  results: CaptainLogEntry[];
}

// ── Restaurant referrals (city captain) ────────────────────────
// Surfaces consumed by /dashboard/referrals. Driven by
// /api/restaurant/referrals and /api/restaurant/referrals/links.
// The local interfaces in marketing/ReferralsSection.tsx predate
// these and are kept as-is for backwards-compat — they have the
// same shape with extra `?` softness, so the runtime cast still
// works against this stricter version.
export type ReferralSource =
  | 'gbref'
  | 'directory'
  | 'admin'
  | 'city_captain'
  | 'city_captain_reengagement'
  | string;

export interface RestaurantReferral {
  _id?: string;
  id?: string;
  customer_name?: string;
  customer_wa_phone?: string;
  customer_bsuid?: string;
  status?: 'active' | 'converted' | 'expired' | 'superseded' | string;
  commission_status?: 'pending' | 'confirmed' | 'settled' | 'reversed' | null;
  source?: ReferralSource;
  referral_code?: string;
  orders_count?: number;
  total_order_value_rs?: number | string;
  referral_fee_rs?: number | string;
  attributed_order_subtotal?: number | string;
  created_at?: string;
  expires_at?: string;
}

export interface RestaurantReferralsSummary {
  total: number;
  converted: number;
  total_orders: number;
  total_order_value_rs: number;
  total_referral_fee_rs: number;
}

export interface RestaurantReferralsResponse {
  summary: RestaurantReferralsSummary;
  referrals: RestaurantReferral[];
}

export interface RestaurantReferralLink {
  _id?: string;
  id?: string;
  code: string;
  campaign_name?: string | null;
  wa_link?: string;
  click_count?: number;
  status?: string;
  source?: ReferralSource;
  listing_id?: string | null;
  created_at?: string;
}

export interface RestaurantReferralLinksResponse {
  links: RestaurantReferralLink[];
}

// Listing-level funnel + 14-day daily time series.
export interface ListingAnalytics {
  days: number;
  actions: {
    listing_card_shown: number;
    menu_viewed: number;
    tapped_notify_me: number;
    tapped_order_handoff: number;
    gbref_link_generated: number;
    gbref_order_attributed: number;
  };
  funnel: {
    impression_to_view: number;
    view_to_action: number;
    action_to_conversion: number;
  };
  notify_intents: { total: number; unfulfilled: number; fulfilled: number };
  time_series: Array<{ date: string; action: string; count: number }>;
}

// ── Domain enums ────────────────────────────────────────────────────

export type FoodType = 'veg' | 'non_veg' | 'egg' | 'vegan';

// Mirrors STATUS_BADGE in OrderCard.jsx plus PAID_OUT (settlements).
export type OrderStatus =
  | 'PENDING'
  | 'PENDING_PAYMENT'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'PAID'
  | 'CONFIRMED'
  | 'PREPARING'
  | 'PACKED'
  | 'DISPATCHED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'PAID_OUT';

// ── Restaurant ──────────────────────────────────────────────────────

export interface WabaAccount {
  waba_id?: string;
  phone_number_id?: string;
  display_name?: string;
  quality_rating?: string;
  [k: string]: unknown;
}

export interface Restaurant {
  id?: string;
  brand_name?: string;
  registered_business_name?: string;
  slug?: string;
  store_url?: string;
  phone?: string;
  email?: string;
  owner_name?: string;
  owner_email?: string;
  whatsapp_connected?: boolean;
  meta_user_id?: string;
  meta_catalog_id?: string;
  catalog_id?: string;
  waba_accounts?: WabaAccount[];
  // Marketing WhatsApp number — the dedicated promotional number used
  // by campaigns, cart-recovery, and dine-in QR check-in. The ID is
  // the raw Meta phone_number_id; display_phone is the human-readable
  // number joined server-side from the matching waba_accounts entry,
  // for surfaces (e.g. dine-in QR wa.me deeplink) that need it without
  // walking the array themselves. Both null when no marketing number
  // is configured — render a "configure in Settings" prompt in that
  // case rather than falling back to the ordering number.
  marketing_wa_phone_number_id?: string | null;
  marketing_wa_display_phone?: string | null;
  campaign_daily_cap?: number | null;
  cart_recovery_discount_pct?: number | null;
  status?: string;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

// ── Branch ──────────────────────────────────────────────────────────

export interface Branch {
  id: string;
  restaurant_id?: string;
  name: string;
  city?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  pincode?: string;
  area?: string;
  state?: string;
  place_id?: string;
  branch_slug?: string;
  delivery_radius_km?: number;
  opening_time?: string;
  closing_time?: string;
  manager_phone?: string;
  fssai_number?: string;
  gst_number?: string;
  catalog_id?: string;
  // Subscription / billing state per branch. Drives the paywall gate
  // on creation and ongoing access. paid_through_date is set forward
  // by each successful billing cycle and consulted by the billing job
  // to flip status to 'paused' when it elapses.
  //   pending_payment — awaiting first/next subscription payment
  //   active          — paid through paid_through_date
  //   paused          — auto-paused (paid_through_date elapsed)
  //   force_paused    — admin-paused (manual ops action)
  subscription_status?: 'pending_payment' | 'active' | 'paused' | 'force_paused';
  paid_through_date?: string | null;
  // Per-branch menu-item count, attached server-side by GET /branches.
  // Used by the menu page's per-branch sync badge ("✓ Catalog" vs "✗ No
  // Items"). Optional because callers shaped through other code paths
  // (single-branch fetch, edit form, etc.) may not include it.
  item_count?: number;
  is_active?: boolean;
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface BranchHoursDay {
  open: string;
  close: string;
  is_closed?: boolean;
}

export interface BranchHours {
  monday?: BranchHoursDay;
  tuesday?: BranchHoursDay;
  wednesday?: BranchHoursDay;
  thursday?: BranchHoursDay;
  friday?: BranchHoursDay;
  saturday?: BranchHoursDay;
  sunday?: BranchHoursDay;
  [k: string]: BranchHoursDay | undefined;
}

// ── Dine-in ─────────────────────────────────────────────────────────
// Per-branch QR check-in config. Mirrors branches.dine_in_config on
// the backend. enabled:false by default so existing branches stay
// unaffected; the QR scan path still acks with a plain
// "Thanks for visiting!" until the operator opts in. Thresholds are
// stored sorted ascending — the PATCH route validates that contract.
export interface DineInConfig {
  points_per_visit: number;
  milestone_thresholds: number[];
  points_expiry_days: number;
  enabled: boolean;
}

// One row in the dine_in_visits ledger. visit_number is the nth visit
// for this customer at this branch (precomputed at insert time on the
// backend so the dashboard can render "Visit #N" without a count
// query on read). customer_phone_masked is the server-side mask
// (••••XXXX) — full phone never leaves the backend for this surface.
export interface DineInVisit {
  _id: string;
  customer_id: string;
  customer_name?: string | null;
  customer_phone_masked?: string | null;
  source: 'qr' | 'staff' | 'pos';
  points_earned: number;
  visit_number: number;
  created_at: string;
}

export interface DineInVisitsResponse {
  success: boolean;
  branch_id: string;
  page: number;
  page_size: number;
  total: number;
  pages: number;
  visits: DineInVisit[];
}

export interface DineInConfigResponse {
  success: boolean;
  branch_id: string;
  dine_in_config: DineInConfig;
}

export interface DineInCheckinResponse {
  success: boolean;
  customer_id: string;
  branch_id: string;
  visit_number: number;
  points_balance: number;
  milestone_hit: number | null;
}

// ── Menu ────────────────────────────────────────────────────────────

export interface MenuItem {
  id: string;
  product_id?: string;
  retailer_id?: string;
  name: string;
  description?: string;
  variant_type?: string;
  variant_value?: string;
  variant_label?: string;
  size?: string;
  food_type?: FoodType;
  price_paise?: number;
  price_rs?: number;
  sale_price_rs?: number;
  category_id?: string;
  category_name?: string;
  branch_id?: string;
  image_url?: string;
  thumbnail_url?: string;
  image_s3_key?: string;
  item_group_id?: string;
  product_tags?: string[];
  available?: boolean;
  quantity_to_sell_on_facebook?: number;
  [k: string]: unknown;
}

export interface MenuGroup {
  category_id?: string;
  category_name: string;
  items: MenuItem[];
  [k: string]: unknown;
}

export interface MenuAllResponse {
  total_count: number;
  groups?: MenuGroup[];
  items?: MenuItem[];
  [k: string]: unknown;
}

// ── Orders ──────────────────────────────────────────────────────────

export interface OrderItem {
  product_id?: string;
  name?: string;
  qty?: number;
  price_paise?: number;
  price_rs?: number;
  variant_value?: string;
  [k: string]: unknown;
}

export interface Order {
  id: string;
  order_number: string;
  // Per-restaurant short display id (e.g. "ZM-0504-018"). Populated for
  // orders created after the order_abbr rollout; falls back to a slice
  // of `id` in restaurant-facing UI when missing.
  display_order_id?: string;
  status: OrderStatus;
  customer_name?: string;
  wa_phone?: string;
  bsuid?: string;
  branch_id?: string;
  branch_name?: string;
  total_rs?: number;
  total_paise?: number;
  eta_text?: string;
  items?: OrderItem[];
  created_at?: string;
  delivered_at?: string;
  // Prorouting (3PL) proof URLs + state — populated on the order doc by
  // the status-callback handler at routes/webhookProrouting.js. Surfaced
  // in the order detail modal for delivered / RTO orders.
  prorouting_pickup_proof?: string;
  prorouting_delivery_proof?: string;
  prorouting_state?: string;
  prorouting_tracking_url?: string;
  // Per-state timestamps stamped by routes/webhookProrouting.js as the
  // 3PL fires status callbacks. DeliveryTimeline renders a checklist-style
  // milestone view from these. Forward path: assigned → at_pickup →
  // pickedup → at_delivery → delivered. RTO branch (after pickup):
  // rto_initiated → rto_delivered (back to merchant) OR rto_disposed
  // (state-only, no separate stamp). cancelled_at applies pre-pickup only.
  prorouting_assigned_at?: string;
  prorouting_pickedup_at?: string;
  prorouting_delivered_at?: string;
  prorouting_at_pickup_at?: string;
  prorouting_at_delivery_at?: string;
  prorouting_rto_initiated_at?: string;
  prorouting_rto_delivered_at?: string;
  prorouting_cancelled_at?: string;
  // Prorouting-side dispute (FLM08 fake delivery, FLM02 wrong-item, etc.)
  // raised against the 3PL. Populated by the report-fake-delivery routes
  // and the generic admin /orders/:id/issue endpoint. UI surfaces these
  // via IssueStatusBadge.
  prorouting_issue_id?: string;
  prorouting_issue_state?: string;
  prorouting_issue_raised_at?: string;
  [k: string]: unknown;
}

// ── Customer ────────────────────────────────────────────────────────

export interface Customer {
  id?: string;
  customer_id?: string;
  wa_phone?: string;
  customer_name?: string;
  segment?: string;
  total_orders?: number;
  total_spend_rs?: number;
  last_order_at?: string;
  tags?: string[];
  [k: string]: unknown;
}

// ── Customer Persona ────────────────────────────────────────────────
// Mirrors the persona document maintained by the persona builder
// (super_admin / city_ops scoped endpoints under /api/admin/personas/*).
// Drives the admin Personas dashboard, inspector, and audience query
// builder. Field set is contract-locked with the backend builder; new
// fields must bump schema_version on both ends.

export interface CuisineAffinityScore { [cuisine: string]: number }

export interface CustomerPersona {
  customer_id: string;
  cuisine_affinity: CuisineAffinityScore;
  price_sensitivity: 'budget' | 'mid' | 'premium';
  order_frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'lapsed' | 'never';
  time_patterns: Array<'breakfast' | 'lunch' | 'dinner' | 'late_night'>;
  veg_strictness: 'strict_veg' | 'flexible_veg' | 'omnivore';
  discovery_stage: 'never_active' | 'captain_browser' | 'converted' | 'repeat_customer' | 'loyal';
  area_clusters: string[];
  engagement_score: number;
  last_active_at: string | null;
  customer_lifetime_value_rs: number;
  total_orders: number;
  gbref_conversion_count: number;
  total_captain_sessions: number;
  primary_city_id: string | null;
  schema_version: number;
  recompute_at?: string;
}

export interface PersonaDistribution {
  discovery_stage: Record<string, number>;
  price_sensitivity: Record<string, number>;
  order_frequency: Record<string, number>;
  veg_strictness: Record<string, number>;
}

export interface PersonaSampleRow {
  customer_id: string;
  discovery_stage: CustomerPersona['discovery_stage'];
  top_cuisines: Array<{ cuisine: string; score: number }>;
  last_active_at: string | null;
}

export interface PersonaQueryResult {
  count: number;
  sample: PersonaSampleRow[];
}

export interface PersonaQueryParams {
  city_id?: string;
  cuisine?: string;
  min_cuisine_score?: number;
  price_sensitivity?: string[];
  order_frequency?: string[];
  veg_strictness?: string[];
  discovery_stage?: string[];
  area?: string[];
}

// ── Analytics ───────────────────────────────────────────────────────

export interface AnalyticsSummary {
  summary: {
    total_orders: number;
    total_revenue: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// ── Marketing ───────────────────────────────────────────────────────

export interface Campaign {
  id: string;
  name: string;
  status?: string;
  branch_id?: string;
  segment?: string;
  schedule_at?: string;
  header_text?: string;
  body_text?: string;
  product_ids?: string[];
  tags?: string[];
  created_at?: string;
  [k: string]: unknown;
}

export interface SegmentAnalytics {
  customer_count: number;
  opted_out_count: number;
  opt_out_rate: number;
  orders_30d: { count: number; revenue: number };
  orders_90d: { count: number; revenue: number };
  avg_order_value_90d: number;
  messages_sent: number;
}

// ── Notifications ───────────────────────────────────────────────────

export interface Notification {
  id: string;
  read?: boolean;
  read_at?: string;
  title?: string;
  body?: string;
  link?: string;
  created_at?: string;
  [k: string]: unknown;
}

// ── Admin ───────────────────────────────────────────────────────────

export interface AdminRestaurant {
  id: string;
  name?: string;
  brand_name?: string;
  registered_business_name?: string;
  slug?: string;
  status?: string;
  orders?: number;
  revenue?: number;
  campaign_daily_cap?: number | null;
  created_at?: string;
  [k: string]: unknown;
}

// ─── Penalties ─────────────────────────────────────────────────
// Per-order cancellation_fault_fee record surfaced by
// GET /api/restaurant/penalties. Mirrors the subdocument written by
// services/orderCancellationService.handleRestaurantFault.
export interface CancellationFaultFee {
  orderId: string;
  orderNumber: string;
  amount: number;
  reason: 'rejected_by_restaurant' | 'restaurant_timeout';
  orderTotal: number;
  createdAt: string;
}

export interface PenaltiesSummary {
  totalFaultFees: number;
  faultFees: CancellationFaultFee[];
}

// ─── Admin Fees Overview ───────────────────────────────────────
// Surface for GET /api/admin/fees/{summary,restaurant-faults,platform-absorbed}.
// Mirrors the cancellation_fault_fee + platform_absorbed_fee subdocuments
// written by services/orderCancellationService.
export interface AdminFeesSummary {
  totalRestaurantFaultFees: number;
  totalPlatformAbsorbedFees: number;
  restaurantFaultCount: number;
  platformAbsorbedCount: number;
}

export interface AdminRestaurantFaultFee {
  orderId: string;
  orderNumber: string;
  restaurantId: string;
  restaurantName: string;
  amount: number;
  reason: 'rejected_by_restaurant' | 'restaurant_timeout';
  orderTotal: number;
  createdAt: string;
}

export interface AdminPlatformAbsorbedFee {
  orderId: string;
  orderNumber: string;
  restaurantId: string;
  restaurantName: string;
  amount: number;
  reason: 'no_rider_found';
  orderTotal: number;
  createdAt: string;
}

// ─── Branch Staff Link ─────────────────────────────────────────
// Surface for GET /api/restaurant/branches/:id/staff-link and
// POST /api/restaurant/branches/:id/staff-link/generate. The token
// is the per-branch UUID staff use to resolve their branch at sign-in;
// staff_login_url is the shareable {FRONTEND_URL}/staff/{token} link.
export interface BranchStaffLink {
  staff_access_token: string | null;
  staff_login_url: string | null;
  generated_at: string | null;
}

// ─── Web Staff Interface ───────────────────────────────────────
// Surfaces consumed by /staff/[staffAccessToken] (web POS for
// staff who can't install the Android APK — browser fallback).
//
// StaffAuthResult mirrors the JSON returned by POST /api/staff/auth
// (see backend/src/routes/staff.js). We only persist `token` to
// localStorage as 'staff_web_token'; the rest is rendered once
// in the orders page header.
export interface StaffAuthResultRestaurant {
  id: string;
  name: string | null;
  slug: string | null;
  logo_url: string | null;
}

export interface StaffAuthResultUser {
  id: string;
  name: string;
  branchId: string;
  permissions: Record<string, boolean>;
}

export interface StaffAuthResult {
  success: true;
  token: string;
  restaurant: StaffAuthResultRestaurant;
  staffUser: StaffAuthResultUser;
}

// Mirrors the per-row payload of GET /api/staff/orders. Distinct
// from `Order` (the owner-dashboard shape) because the staff route
// returns masked phones and a flatter items[] projection.
export interface StaffOrderItem {
  name: string;
  quantity: number;
}

export interface StaffOrder {
  id: string;
  order_number: string | number;
  display_order_id?: string;
  customer_name: string;
  customer_phone_masked: string;
  total_rs: number;
  total_amount: number;
  status: OrderStatus;
  payment_status: string | null;
  branch_id: string | null;
  accepted_at: string | null;
  created_at: string;
  items: StaffOrderItem[];
}

// ─── Admin ↔ Restaurant Direct Messages ────────────────────────
// Shape for the admin-restaurant DM thread surfaced in the dashboard
// and admin Message drawers. Backed by the `admin_restaurant_messages`
// Mongo collection (separate from the customer inbox / WhatsApp
// archives — see backend/src/routes/admin.js for the writer).
export interface AdminRestaurantMessage {
  id: string;
  from: 'admin' | 'restaurant';
  restaurantId: string;
  message: string;
  read: boolean;
  created_at: string;
}

export interface AdminRestaurantMessagesResponse {
  messages: AdminRestaurantMessage[];
}

// ─── Staff Auth (PIN + Bearer) ────────────────────────────────
// Patched contract (post-Part 5): staff log in via store_slug + staff_id
// + 4-digit PIN, no per-branch URL token. Owners manage staff via
// /api/restaurant/staff*. The backend returns SanitizedStaff rows.

// 10 canonical permission keys. Constrain types so a typo in a caller
// (e.g. permissions.acept_orders) is a compile error.
export type Permission =
  | 'view_orders'
  | 'accept_orders'
  | 'reject_orders'
  | 'mark_ready'
  | 'manage_menu'
  | 'manage_stock'
  | 'view_reports'
  | 'manage_settings'
  | 'refund_orders'
  | 'view_customer_details';

export const PERMISSION_KEYS: ReadonlyArray<Permission> = [
  'view_orders',
  'accept_orders',
  'reject_orders',
  'mark_ready',
  'manage_menu',
  'manage_stock',
  'view_reports',
  'manage_settings',
  'refund_orders',
  'view_customer_details',
];

// Friendly labels for each permission key — used by the management
// modal toggles + the orders screen's denial copy.
export const PERMISSION_LABELS: Record<Permission, string> = {
  view_orders: 'View orders',
  accept_orders: 'Accept orders',
  reject_orders: 'Reject orders',
  mark_ready: 'Mark ready / packed',
  manage_menu: 'Manage menu',
  manage_stock: 'Manage stock',
  view_reports: 'View reports',
  manage_settings: 'Manage settings',
  refund_orders: 'Refund orders',
  view_customer_details: 'View customer details',
};

export type Permissions = Record<Permission, boolean>;

export type RolePreset = 'cashier' | 'kitchen' | 'branch_manager' | 'owner' | 'custom';

// SanitizedStaff response shape. Backend serialises both `is_active` /
// `active` and `branch_ids` / `branchIds` for compatibility with the
// older mobile app. The dashboard prefers the snake_case canonical
// fields but accepts either when reading.
export interface Staff {
  _id: string;
  restaurant_id: string;
  staff_id: string;
  name: string;
  display_name: string;
  phone?: string;
  role: string;
  role_preset: RolePreset;
  branch_ids: string[];
  branchIds: string[];
  permissions: Permissions;
  is_active: boolean;
  active: boolean;
  created_at: string;
  last_active_at?: string;
}

// Lightweight projection for the staff branch picker. The
// dashboard's full Branch type carries 30+ fields; this narrows to
// the two the modal needs so calling code doesn't have to fabricate
// the rest.
export interface BranchSummary {
  id: string;
  name: string;
}

// ─── Pincode State Summary ────────────────────────────────────
// Returned by GET /api/admin/pincodes/states. One row per state present
// in the serviceable_pincodes collection — drives the admin pincodes
// accordion at mount time. Counts come from a $group/$sum aggregation
// (see backend/src/routes/adminPincodes.js GET /states).
export interface PincodeStateSummary {
  state: string;
  total_pincodes: number;
  enabled_count: number;
  disabled_count: number;
  last_updated?: string | null;
}
