const STATS = [
  { value: 'Zero', label: 'Commission' },
  { value: '₹0', label: 'Setup Fee' },
  { value: '24 hrs', label: 'Time to Launch' },
  { value: '100%', label: 'Customer Data' },
];

export default function StatsStrip() {
  return (
    <section className="landing-stats" aria-label="GullyBite at a glance">
      <div className="landing-stats-grid">
        {STATS.map(({ value, label }) => (
          <div key={label} className="landing-stat">
            <div className="landing-stat-value">{value}</div>
            <div className="landing-stat-label">{label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
