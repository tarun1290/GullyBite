export default function Card({ title, actions, children, className = '' }) {
  const classes = ['card', className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      {(title || actions) && (
        <div className="ch">
          {title && <h3>{title}</h3>}
          {actions && <div>{actions}</div>}
        </div>
      )}
      {children && <div className="cb">{children}</div>}
    </div>
  );
}
