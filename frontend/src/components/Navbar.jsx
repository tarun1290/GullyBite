export default function Navbar({ title, subtitle, actions, onMenuClick }) {
  return (
    <div className="topbar">
      <div className="topbar-l">
        {onMenuClick && (
          <button
            type="button"
            className="nav-burger"
            aria-label="Open menu"
            onClick={onMenuClick}
          >
            <span />
            <span />
            <span />
          </button>
        )}
        <div>
          {title && <h1>{title}</h1>}
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="topbar-r">{actions}</div>}
    </div>
  );
}
