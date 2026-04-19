import { useState } from 'react';
import CampaignsSection from '../../components/dashboard/marketing/CampaignsSection.jsx';
import CouponsSection from '../../components/dashboard/marketing/CouponsSection.jsx';
import ReferralsSection from '../../components/dashboard/marketing/ReferralsSection.jsx';
import MarketingMessagesSection from '../../components/dashboard/marketing/MarketingMessagesSection.jsx';

// Legacy splits these across four sidebar tabs (tab-campaigns / tab-coupons /
// tab-referrals / tab-marketing). Here we unify them behind a single
// Marketing tab with a section switch — load only the active section so
// network calls are lazy, matching the Analytics-tab pattern.
const SECTIONS = [
  ['campaigns', '📢 Campaigns'],
  ['coupons', '🎟 Coupons'],
  ['referrals', '🤝 Referrals'],
  ['messages', '📣 Marketing Messages'],
];

export default function MarketingTab() {
  const [activeSection, setActiveSection] = useState('campaigns');

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
