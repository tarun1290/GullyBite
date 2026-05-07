'use client';

import { useState } from 'react';
import FinancialSummarySection from '../../../components/restaurant/payments/FinancialSummarySection';
import SettlementsSection from '../../../components/restaurant/payments/SettlementsSection';
import WalletSection from '../../../components/restaurant/payments/WalletSection';
import TaxSummarySection from '../../../components/restaurant/payments/TaxSummarySection';

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['summary', '📊 Summary'],
  ['settlements', '💰 Settlements'],
  ['wallet', '💳 Wallet'],
  ['tax', '📋 Tax'],
];

export default function PaymentsPage() {
  const [activeSection, setActiveSection] = useState<string>('summary');

  return (
    <div id="tab-payments-wrap">
      <div className="chips mb-4">
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

      {activeSection === 'summary' && <FinancialSummarySection />}
      {activeSection === 'settlements' && <SettlementsSection />}
      {activeSection === 'wallet' && <WalletSection />}
      {activeSection === 'tax' && <TaxSummarySection />}
    </div>
  );
}
