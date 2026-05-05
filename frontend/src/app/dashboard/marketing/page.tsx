'use client';

import { useState } from 'react';
import CampaignsSection from '../../../components/restaurant/marketing/CampaignsSection';
import CouponsSection from '../../../components/restaurant/marketing/CouponsSection';
import ReferralsSection from '../../../components/restaurant/marketing/ReferralsSection';
import MarketingMessagesSection from '../../../components/restaurant/marketing/MarketingMessagesSection';

type SectionKey = 'campaigns' | 'coupons' | 'referrals' | 'messages';

const SECTIONS: ReadonlyArray<readonly [SectionKey, string]> = [
  ['campaigns', '📢 Campaigns'],
  ['coupons', '🎟 Coupons'],
  ['referrals', '🤝 Referrals'],
  ['messages', '📣 Marketing Messages'],
];

export default function MarketingPage() {
  const [activeSection, setActiveSection] = useState<SectionKey>('campaigns');

  return (
    <div id="tab-marketing-wrap">
      <div className="chips" style={{ marginBottom: '1rem' }}>
        {SECTIONS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={activeSection === value ? 'chip on' : 'chip'}
            onClick={() => setActiveSection(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeSection === 'campaigns' && <CampaignsSection />}
      {activeSection === 'coupons' && <CouponsSection />}
      {activeSection === 'referrals' && <ReferralsSection />}
      {activeSection === 'messages' && <MarketingMessagesSection />}
    </div>
  );
}
