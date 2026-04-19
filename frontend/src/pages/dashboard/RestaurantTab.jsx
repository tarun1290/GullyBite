import { useState } from 'react';
import BranchesSection from '../../components/dashboard/restaurant/BranchesSection.jsx';
import UsersSection from '../../components/dashboard/restaurant/UsersSection.jsx';

// Mirrors the legacy "Restaurant" area which was split across #tab-branches
// (menu.js) and #tab-team (restaurant.js). Phase 2l consolidates the two into
// a single React tab with chip-style sub-nav matching the Menu tab pattern.
//
// Other legacy sub-sections (customers, ratings, loyalty, referrals, coupons,
// campaigns) moved to Analytics / Marketing tabs in earlier phases — they're
// intentionally NOT re-exposed here.
const SECTIONS = [
  ['branches', '🏪 Branches'],
  ['users', '👥 Staff / Users'],
];

export default function RestaurantTab() {
  const [activeSection, setActiveSection] = useState('branches');

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: '.35rem',
          flexWrap: 'wrap',
          marginBottom: '1.1rem',
          padding: '.5rem 0',
          borderBottom: '1px solid var(--rim)',
        }}
      >
        {SECTIONS.map(([v, l]) => (
          <button
            key={v}
            type="button"
            className={activeSection === v ? 'chip on' : 'chip'}
            onClick={() => setActiveSection(v)}
          >
            {l}
          </button>
        ))}
      </div>

      {activeSection === 'branches' && <BranchesSection />}
      {activeSection === 'users' && <UsersSection />}
    </div>
  );
}
