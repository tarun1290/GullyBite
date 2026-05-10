// Role-aware feature gating for the staff app.
//
// Reads the persisted role from the auth store (sourced from
// /api/staff/auth's staffUser.role field, or the gb_user_role
// SecureStore key for owner sessions / legacy hydration).
//
// `isManager` is true for both 'manager' and 'owner' so a single
// `{isManager && ...}` guard covers any branch-management surface
// (open/close toggle, daily summary, settlement, staff list) that
// should be visible to everyone except plain operational staff.
// `isStaff` is the explicit complement for 'staff'-only conditionals.
//
// Both flags are false during the initial hydration tick (role is
// null) — callers that fire side effects on role changes should
// guard with `isLoading` from useStaff() if they need the distinction.

import { useStaff } from '../state/StaffContext';

export interface RoleFlags {
  isManager: boolean;
  isStaff: boolean;
}

export function useRole(): RoleFlags {
  const { role } = useStaff();
  return {
    isManager: role === 'manager' || role === 'owner',
    isStaff: role === 'staff',
  };
}
