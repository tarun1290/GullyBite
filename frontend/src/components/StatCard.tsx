import type { ReactNode } from 'react';

type StatColor = 'indigo' | 'green' | 'amber' | 'red';

const COLOR_MAP: Record<StatColor, string> = {
  indigo: 'var(--acc)',
  green:  'var(--wa)',
  amber:  'var(--gold)',
  red:    'var(--red)',
};

interface StatCardProps {
  label?: string;
  value: ReactNode;
  delta?: ReactNode;
  deltaType?: 'up' | 'down' | 'neutral';
  color?: StatColor;
}

export default function StatCard({
  label,
  value,
  delta,
  deltaType = 'neutral',
  color = 'indigo',
}: StatCardProps) {
  const accentColor = COLOR_MAP[color] || COLOR_MAP.indigo;
  const deltaClass = deltaType === 'down' ? 'stat-s dn' : 'stat-s';
  return (
    <div
      className="stat pl-[1.1rem] border-l-4"
      // accent border colour comes from COLOR_MAP by `color` prop at
      // runtime (indigo/green/amber/red — 4 distinct CSS vars).
      style={{ borderLeftColor: accentColor }}
    >
      {label && <div className="stat-l">{label}</div>}
      <div className="stat-v">{value}</div>
      {delta && <div className={deltaClass}>{delta}</div>}
    </div>
  );
}
