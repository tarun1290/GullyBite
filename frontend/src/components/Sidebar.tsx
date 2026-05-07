'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../contexts/AuthContext';

export interface NavItem {
  label: string;
  icon: string;
  path: string;
}

interface SidebarProps {
  navItems: NavItem[];
  onLogout?: () => void;
  brandLabel?: string;
  brandIcon?: string;
  restaurantName?: string;
  open?: boolean;
  onClose?: () => void;
}

export default function Sidebar({
  navItems,
  onLogout,
  brandLabel = 'GullyBite',
  brandIcon = '🍜',
  restaurantName,
  open = false,
  onClose,
}: SidebarProps) {
  const { user } = useAuth();
  const pathname = usePathname();
  const fallbackName = (typeof user?.restaurant_name === 'string' && user.restaurant_name) || user?.name || 'Restaurant';
  const displayName = restaurantName || fallbackName;
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
            ✕
          </button>
        </div>
        <div className="sb-sec">
          {navItems.map((item) => (
            <Link
              key={item.path}
              href={item.path}
              className={pathname === item.path ? 'sb-btn act' : 'sb-btn'}
              onClick={handleNavClick}
            >
              <span className="ic">{item.icon}</span>
              {item.label}
            </Link>
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
              className="sb-btn mt-3"
              onClick={onLogout}
            >
              <span className="ic">⇥</span>
              Logout
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
