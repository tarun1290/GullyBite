'use client';

import { useState } from 'react';
import BranchesSection from '../../../components/restaurant/BranchesSection';
import UsersSection from '../../../components/restaurant/UsersSection';

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['branches', '🏪 Branches'],
  ['users', '👥 Staff / Users'],
];

export default function RestaurantPage() {
  const [activeSection, setActiveSection] = useState<string>('branches');

  return (
    <div>
      <div className="flex gap-[0.35rem] flex-wrap mb-[1.1rem] py-2 border-b border-rim">
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
