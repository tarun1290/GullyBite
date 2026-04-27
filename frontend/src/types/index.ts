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
  campaign_daily_cap?: number | null;
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
