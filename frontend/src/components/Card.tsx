'use client';

import type { ReactNode } from 'react';

interface CardProps {
  title?: string;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export default function Card({ title, actions, children, className = '' }: CardProps) {
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
