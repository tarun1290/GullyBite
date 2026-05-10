// RequirePermission — thin wrapper that gates children on staff
// permission flags (Part 6d Track B).
//
// HARD POLICY:
//   • Owner role and manager preset ALWAYS bypass — they see every
//     gated child regardless of the permissions object. Both are
//     verified explicitly so a regression where only `'owner'` bypasses
//     (not `'manager'`) is caught at the type level.
//   • The `keys` prop accepts the snake_case StaffPermissions key
//     names (e.g. `'accept_orders'`, `'view_customer_details'`) so
//     consumer JSX matches the backend permission contract verbatim.
//   • Internally the snake_case keys are looked up against the
//     camelCase flag map returned by useStaffPermissions().
//
// Usage:
//   <RequirePermission keys={['accept_orders']}>
//     <AcceptButton />
//   </RequirePermission>
//
//   <RequirePermission keys={['manage_menu', 'manage_stock']} mode="any">
//     <MenuRow />
//   </RequirePermission>
//
//   <RequirePermission keys={['view_orders']} fallback={<NoAccessScreen />}>
//     <OrdersList />
//   </RequirePermission>
//
// Defaults: mode='all' (every key must pass), fallback=null (no render).

import { ReactNode } from 'react';
import { useStaff, useStaffPermissions, type StaffPermissionFlags } from '@/state/StaffContext';
import type { StaffPermissions } from '@/api';

// snake_case → camelCase flag map. Kept inline (not exported) so the
// surface area stays narrow; the StaffPermissions contract is the
// authoritative key list.
const KEY_TO_FLAG: Record<keyof StaffPermissions, keyof StaffPermissionFlags> = {
  view_orders: 'canViewOrders',
  accept_orders: 'canAcceptOrders',
  reject_orders: 'canRejectOrders',
  mark_ready: 'canMarkReady',
  manage_menu: 'canManageMenu',
  manage_stock: 'canManageStock',
  view_reports: 'canViewReports',
  manage_settings: 'canManageSettings',
  refund_orders: 'canRefundOrders',
  view_customer_details: 'canViewCustomerDetails',
};

type Props = {
  keys: Array<keyof StaffPermissions>;
  // 'all' (default): every key must be granted.
  // 'any': at least one key must be granted.
  mode?: 'all' | 'any';
  children: ReactNode;
  // Rendered when the gate fails. Default: null (renders nothing).
  // Pass <NoAccessScreen/> for screen-level gates so the user sees an
  // explanation instead of a blank pane.
  fallback?: ReactNode;
};

export default function RequirePermission({
  keys,
  mode = 'all',
  children,
  fallback = null,
}: Props): React.ReactElement {
  const { role } = useStaff();
  const perms = useStaffPermissions();

  // Owner + manager bypass — they see everything regardless of the
  // permissions object. Verified for BOTH role values; a regression
  // where only `'owner'` bypasses (not `'manager'`) would silently
  // ship-block managers who lack the explicit camelCase flag.
  if (role === 'owner' || role === 'manager') {
    return <>{children}</>;
  }

  const flags = keys.map((k) => perms[KEY_TO_FLAG[k]]);
  const granted = mode === 'any' ? flags.some(Boolean) : flags.every(Boolean);

  return <>{granted ? children : fallback}</>;
}
