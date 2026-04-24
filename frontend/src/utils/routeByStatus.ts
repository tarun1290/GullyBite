// Port of routeByStatus from legacy frontend/index.html:999-1013.
// Reads me.approval_status (not me.status) and me.onboarding_step (defaults to 1).
//
// Callers:
//   - Landing route passes { showPage, navigate }. On auth-adjacent outcomes
//     (rejected / onboard), showPage toggles a local page-state. For the final
//     dashboard hand-off, navigate routes to the role-appropriate path.
//   - Login route passes { navigate } only. showPage-style outcomes become
//     navigate('/?page=<id>', { replace: true }).

import type { AuthUser } from '../types';

interface NavigateOptions {
  replace?: boolean;
}

export interface RouteByStatusOptions {
  showPage?: (id: string) => void;
  navigate: (path: string, opts?: NavigateOptions) => void;
}

export function routeByStatus(me: AuthUser | null, options: RouteByStatusOptions): void {
  const { showPage, navigate } = options;
  if (!me || typeof navigate !== 'function') return;

  const step = (me.onboarding_step as number | undefined) || 1;
  const status = (me.approval_status as string | undefined) || 'pending';

  if (status === 'rejected') {
    if (showPage) showPage('pg-rejected');
    else navigate('/?page=rejected', { replace: true });
    return;
  }

  if (step < 2 || !me.brand_name) {
    if (showPage) showPage('pg-onboard');
    else navigate('/?page=onboard', { replace: true });
    return;
  }

  navigate(me.role === 'admin' ? '/admin/flows' : '/dashboard/overview', { replace: true });
}

export default routeByStatus;
