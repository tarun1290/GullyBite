export default function Navbar({ title, subtitle, actions }) {
  return (
    <div className="topbar">
      <div>
        {title && <h1>{title}</h1>}
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="topbar-r">{actions}</div>}
    </div>
  );
}
