export default function StatCard({ label, value, delta, deltaType = 'neutral' }) {
  const deltaClass =
    deltaType === 'down' ? 'stat-s dn' : deltaType === 'up' ? 'stat-s' : 'stat-s';
  return (
    <div className="stat">
      {label && <div className="stat-l">{label}</div>}
      <div className="stat-v">{value}</div>
      {delta && <div className={deltaClass}>{delta}</div>}
    </div>
  );
}
