import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar.jsx';
import Navbar from '../components/Navbar.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';

const NAV_ITEMS = [
  { label: 'Flows',       icon: '\uD83D\uDD04', path: '/admin/flows' },
  { label: 'Templates',   icon: '\uD83D\uDCC4', path: '/admin/templates' },
  { label: 'Restaurants', icon: '\uD83C\uDFEA', path: '/admin/restaurants' },
  { label: 'Pincodes',    icon: '\uD83D\uDCCD', path: '/admin/pincodes' },
];

const TITLE_BY_PATH = Object.fromEntries(NAV_ITEMS.map((n) => [n.path, n.label]));

export default function AdminLayout() {
  const { logout } = useAuth();
  const location = useLocation();
  const title = TITLE_BY_PATH[location.pathname] || 'Admin';

  return (
    <div id="pg-admin" style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar
        navItems={NAV_ITEMS}
        onLogout={logout}
        brandLabel="GullyBite Admin"
        brandIcon={'\u26A1'}
      />
      <main className="main">
        <Navbar title={title} subtitle="Platform administration" />
        <div className="body">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
