export default function TabBar({ tabs, active, onChange, className = '' }) {
  const classes = ['chips', className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            className={isActive ? 'chip on' : 'chip'}
            onClick={() => onChange && onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
