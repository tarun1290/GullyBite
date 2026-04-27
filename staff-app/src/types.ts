// Canonical staff-app type definitions. Mirrors what /api/staff/auth
// returns (after the staff_access_token migration) and what the SSE
// stream + /api/staff/orders ship. Existing api.ts re-exports older
// shapes for back-compat with the OrderCard / orders screen — those
// will be migrated to these names over time.

export interface StaffUser {
  userId: string;
  name: string;
  branchId: string;
  permissions: Record<string, boolean>;
  role: 'staff';
}

export interface Restaurant {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
}

export interface OrderItem {
  name: string;
  quantity: number;
}

// Mirrors GET /api/staff/orders payload + SSE new_order/order_updated
// events. Status is restricted to the four states staff can act on
// (PAID + CONFIRMED → PREPARING → PACKED chain).
export interface Order {
  orderId: string;
  orderNumber: string;
  status: 'PAID' | 'CONFIRMED' | 'PREPARING' | 'PACKED';
  items: OrderItem[];
  total_amount: number;
  branch_id: string;
  created_at: string;
  accepted_at: string | null;
  delivery_address?: string;
}
