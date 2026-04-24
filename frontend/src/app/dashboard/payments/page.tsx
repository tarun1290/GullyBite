'use client';

import { useState } from 'react';
import FinancialSummarySection from '../../../components/dashboard/payments/FinancialSummarySection';
import SettlementsSection from '../../../components/dashboard/payments/SettlementsSection';
import WalletSection from '../../../components/dashboard/payments/WalletSection';
import TaxSummarySection from '../../../components/dashboard/payments/TaxSummarySection';

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

      {activeSection === 'summary' && <FinancialSummarySection />}
      {activeSection === 'settlements' && <SettlementsSection />}
      {activeSection === 'wallet' && <WalletSection />}
      {activeSection === 'tax' && <TaxSummarySection />}
    </div>
  );
}
