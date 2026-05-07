import type { ReactNode } from 'react';

type StatColor = 'indigo' | 'green' | 'amber' | 'red';

const COLOR_MAP: Record<StatColor, { accent: string; glow: string }> = {
  indigo: { accent: 'var(--acc)',  glow: 'var(--acc-glow)' },
  green:  { accent: 'var(--wa)',   glow: 'var(--wa-glow)' },
  amber:  { accent: 'var(--gold)', glow: 'var(--gold-glow)' },
  red:    { accent: 'var(--red)',  glow: 'rgba(220,38,38,.08)' },
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
  const { accent: accentColor, glow: glowColor } = COLOR_MAP[color] || COLOR_MAP.indigo;
  const deltaClass = deltaType === 'down' ? 'stat-s dn' : 'stat-s';
  return (
    <div
      className="stat pl-[1.1rem] border-l-4"
      // accent border colour comes from COLOR_MAP by `color` prop at
      // runtime (indigo/green/amber/red — 4 distinct CSS vars).
      style={{ borderLeftColor: accentColor }}
    >
      <div
        aria-hidden="true"
        className="absolute w-14 h-14 rounded-full -right-3 -top-3 pointer-events-none z-0"
        // glow background colour comes from COLOR_MAP by `color` prop at
        // runtime (4 distinct CSS vars / rgba).
        style={{ background: glowColor }}
      />
      {label && <div className="stat-l relative z-1">{label}</div>}
      <div className="stat-v relative z-1">{value}</div>
      {delta && <div className={`${deltaClass} relative z-1`}>{delta}</div>}
    </div>
  );
}
