'use client';

import { useState } from 'react';
import BusinessInfoSection from '../../../components/dashboard/settings/BusinessInfoSection';
import PricingSection from '../../../components/dashboard/settings/PricingSection';
import NotificationSection from '../../../components/dashboard/settings/NotificationSection';
import WhatsappSection from '../../../components/dashboard/settings/WhatsappSection';
import IntegrationsSection from '../../../components/dashboard/settings/IntegrationsSection';
import PasswordSection from '../../../components/dashboard/settings/PasswordSection';
import DangerZoneSection from '../../../components/dashboard/settings/DangerZoneSection';

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['business', '🏢 Business'],
  ['pricing', '💰 Pricing'],
  ['notifications', '🔔 Notifications'],
  ['whatsapp', '💬 WhatsApp'],
  ['integrations', '🔗 Integrations'],
  ['security', '🔒 Security'],
  ['danger', '⚠️ Danger Zone'],
];

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<string>('business');

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
