import { useState } from 'react';
import BusinessInfoSection from '../../components/dashboard/settings/BusinessInfoSection.jsx';
import PricingSection from '../../components/dashboard/settings/PricingSection.jsx';
import NotificationSection from '../../components/dashboard/settings/NotificationSection.jsx';
import WhatsappSection from '../../components/dashboard/settings/WhatsappSection.jsx';
import IntegrationsSection from '../../components/dashboard/settings/IntegrationsSection.jsx';
import PasswordSection from '../../components/dashboard/settings/PasswordSection.jsx';
import DangerZoneSection from '../../components/dashboard/settings/DangerZoneSection.jsx';

// Mirrors the legacy "Settings" sidebar group which merges tab-settings +
// tab-whatsapp + tab-integrations (see dashboard.html:2651 SIDEBAR_TO_TABS).
// We expose each sub-card as a chip-selectable sub-section so users don't
// scroll through every block at once.
const SECTIONS = [
  ['business', '🏢 Business'],
  ['pricing', '💰 Pricing'],
  ['notifications', '🔔 Notifications'],
  ['whatsapp', '💬 WhatsApp'],
  ['integrations', '🔗 Integrations'],
  ['security', '🔒 Security'],
  ['danger', '⚠️ Danger Zone'],
];

export default function SettingsTab() {
  const [activeSection, setActiveSection] = useState('business');

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

      {activeSection === 'business' && <BusinessInfoSection />}
      {activeSection === 'pricing' && <PricingSection />}
      {activeSection === 'notifications' && <NotificationSection />}
      {activeSection === 'whatsapp' && <WhatsappSection />}
      {activeSection === 'integrations' && <IntegrationsSection />}
      {activeSection === 'security' && <PasswordSection />}
      {activeSection === 'danger' && <DangerZoneSection />}
    </div>
  );
}
