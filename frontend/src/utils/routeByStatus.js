// Port of routeByStatus from legacy frontend/index.html:999-1013.
// Note: legacy reads me.approval_status (not me.status) and me.onboarding_step
// defaulted to 1.
//
// Callers:
//   - Landing.jsx passes { showPage, navigate }. On auth-adjacent outcomes
//     (rejected / onboard), showPage toggles the local page-state within
//     Landing. For the final dashboard hand-off, navigate() routes to the
//     role-appropriate route.
//   - Login.jsx passes { navigate } only. showPage-style outcomes become
//     navigate('/?page=<id>', { replace: true }); Landing mounts, reads the
//     param, and renders the target sub-page.

export function routeByStatus(me, { showPage, navigate } = {}) {
  if (!me || typeof navigate !== 'function') return;
  const step = me.onboarding_step || 1;
  const status = me.approval_status || 'pending';

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
