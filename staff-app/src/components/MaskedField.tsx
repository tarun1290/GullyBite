// MaskedField — renders the actual value only if the user has the
// permission; otherwise renders the placeholder. Used for display-only
// fields (phone, name, email, refund_amount) where hiding would shift
// layout (Part 6d Track B).
//
// HARD POLICY:
//   • Owner role and manager preset ALWAYS bypass — both see the real
//     value regardless of the permissions object.
//   • For fields where a missing value should NOT shift layout, pass
//     a placeholder string (default '—'). The placeholder renders as
//     a Text node so it can sit inside the same container as the
//     real children.
//   • For action buttons, use <RequirePermission/> instead — actions
//     should HIDE COMPLETELY when un-permitted, not display a mask.
//
// Usage:
//   <MaskedField permission="view_customer_details">
//     <Text>{order.customer_phone_masked}</Text>
//   </MaskedField>
//
//   <MaskedField permission="view_customer_details" placeholder="••••">
//     <Text>{phoneTail}</Text>
//   </MaskedField>

import { ReactNode } from 'react';
import { Text } from 'react-native';
import { useStaff, useStaffPermissions, type StaffPermissionFlags } from '@/state/StaffContext';
import type { StaffPermissions } from '@/api';

// Same map as RequirePermission — kept local to each component so
// neither has to import the other and the type-level coupling stays
// minimal. If the contract grows, both maps update together.
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
  permission: keyof StaffPermissions;
  // Default '—'. Pass an empty string to collapse the row entirely
  // (e.g. for the OrderCard phone-tail tail-segment that lives
  // alongside the timeAgo text).
  placeholder?: string;
  children: ReactNode;
};

export default function MaskedField({
  permission,
  placeholder = '—',
  children,
}: Props): React.ReactElement {
  const { role } = useStaff();
  const perms = useStaffPermissions();

  // Owner + manager bypass — both see the real value.
  if (role === 'owner' || role === 'manager') {
    return <>{children}</>;
  }

  const granted = !!perms[KEY_TO_FLAG[permission]];
  if (granted) return <>{children}</>;

  // Render placeholder as a Text node so it nests cleanly inside the
  // same parent container as the real children would have. Empty
  // placeholders still render a (zero-width) Text — RN treats it as
  // an empty inline so the layout stays stable.
  return <Text>{placeholder}</Text>;
}
