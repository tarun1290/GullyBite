import type { ReactNode } from 'react';

interface FieldProps {
  label?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export default function Field({ label, error, hint, children, className = '' }: FieldProps) {
  const classes = ['fg', className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      {label && <label>{label}</label>}
      {children}
      {hint && !error && (
        <small style={{ fontSize: '0.7rem', color: 'var(--mute)' }}>{hint}</small>
      )}
      {error && (
        <small style={{ fontSize: '0.72rem', color: 'var(--red)' }}>{error}</small>
      )}
    </div>
  );
}
