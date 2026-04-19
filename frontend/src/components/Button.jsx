const VARIANT_CLASS = {
  default: 'btn',
  primary: 'btn btn-p',
  small: 'btn btn-sm',
  ghost: 'btn-g',
  danger: 'btn-del',
  'wa-connect': 'btn-wa-connect',
};

export default function Button({
  variant = 'default',
  loading = false,
  onClick,
  type = 'button',
  disabled = false,
  children,
  className = '',
  ...rest
}) {
  const baseClass = VARIANT_CLASS[variant] || VARIANT_CLASS.default;
  const classes = [baseClass, className].filter(Boolean).join(' ');
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      className={classes}
      onClick={onClick}
      disabled={isDisabled}
      {...rest}
    >
      {loading && <span className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
