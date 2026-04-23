const COLOR_MAP = {
  indigo: { accent: 'var(--acc)',  glow: 'var(--acc-glow)' },
  green:  { accent: 'var(--wa)',   glow: 'var(--wa-glow)' },
  amber:  { accent: 'var(--gold)', glow: 'var(--gold-glow)' },
  red:    { accent: 'var(--red)',  glow: 'rgba(220,38,38,.08)' },
};

export default function StatCard({ label, value, delta, deltaType = 'neutral', color = 'indigo' }) {
  const { accent: accentColor, glow: glowColor } = COLOR_MAP[color] || COLOR_MAP.indigo;
  const deltaClass = deltaType === 'down' ? 'stat-s dn' : 'stat-s';
  return (
    <div
      className="stat"
      style={{ borderLeft: `4px solid ${accentColor}`, paddingLeft: '1.1rem' }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: glowColor,
          right: -12,
          top: -12,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      {label && <div className="stat-l" style={{ position: 'relative', zIndex: 1 }}>{label}</div>}
      <div className="stat-v" style={{ position: 'relative', zIndex: 1 }}>{value}</div>
      {delta && <div className={deltaClass} style={{ position: 'relative', zIndex: 1 }}>{delta}</div>}
    </div>
  );
}
