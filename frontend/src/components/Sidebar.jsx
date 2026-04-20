import { NavLink } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function Sidebar({
  navItems,
  onLogout,
  brandLabel = 'GullyBite',
  brandIcon = '\uD83C\uDF5C',
  restaurantName,
  open = false,
  onClose,
}) {
  const { user } = useAuth();
  const displayName = restaurantName || user?.restaurant_name || user?.name || 'Restaurant';
  const displayRole = user?.role === 'admin' ? 'Admin' : 'Owner';
  const avatarLetter = (displayName || 'R').trim().charAt(0).toUpperCase();

  const handleNavClick = () => {
    if (onClose) onClose();
  };

  return (
    <>
      {open && (
        <div
          className="sb-overlay"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside className={open ? 'sb open' : 'sb'}>
        <div className="sb-logo">
          <div className="logo-ring">{brandIcon}</div>
          {brandLabel}
          <button
            type="button"
            className="sb-close"
            aria-label="Close menu"
            onClick={onClose}
          >
            {'\u2715'}
          </button>
        </div>
        <div className="sb-sec">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => (isActive ? 'sb-btn act' : 'sb-btn')}
              end={item.end}
              onClick={handleNavClick}
            >
              <span className="ic">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>
        <div className="sb-foot">
          <div className="sb-user">
            <div className="sb-av">{avatarLetter}</div>
            <div>
              <div className="sb-nm">{displayName}</div>
              <div className="sb-rl">{displayRole}</div>
            </div>
          </div>
          {onLogout && (
            <button
              type="button"
              className="sb-btn"
              style={{ marginTop: '0.75rem' }}
              onClick={onLogout}
            >
              <span className="ic">{'\u21E5'}</span>
              Logout
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
