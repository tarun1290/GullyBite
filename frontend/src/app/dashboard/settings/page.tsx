'use client';

import { useState } from 'react';
import BusinessInfoSection from '../../../components/restaurant/settings/BusinessInfoSection';
import PricingSection from '../../../components/restaurant/settings/PricingSection';
import NotificationSection from '../../../components/restaurant/settings/NotificationSection';
import WhatsappSection from '../../../components/restaurant/settings/WhatsappSection';
import IntegrationsSection from '../../../components/restaurant/settings/IntegrationsSection';
import PasswordSection from '../../../components/restaurant/settings/PasswordSection';

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['business', '🏢 Business'],
  ['pricing', '💰 Pricing'],
  ['notifications', '🔔 Notifications'],
  ['whatsapp', '💬 WhatsApp'],
  ['integrations', '🔗 Integrations'],
  ['security', '🔒 Security'],
];

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<string>('business');

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

      {activeSection === 'business' && <BusinessInfoSection />}
      {activeSection === 'pricing' && <PricingSection />}
      {activeSection === 'notifications' && <NotificationSection />}
      {activeSection === 'whatsapp' && <WhatsappSection />}
      {activeSection === 'integrations' && <IntegrationsSection />}
      {activeSection === 'security' && <PasswordSection />}
    </div>
  );
}
