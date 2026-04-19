import { useState } from 'react';
import FinancialSummarySection from '../../components/dashboard/payments/FinancialSummarySection.jsx';
import SettlementsSection from '../../components/dashboard/payments/SettlementsSection.jsx';
import WalletSection from '../../components/dashboard/payments/WalletSection.jsx';
import TaxSummarySection from '../../components/dashboard/payments/TaxSummarySection.jsx';

// Legacy splits payments across three sidebar tabs (tab-financials,
// tab-settlements, tab-wallet) per dashboard.html:2648. We unify them
// into one Payments tab with a section switch — each section is
// lazy-mounted so its fetch runs only once the user navigates to it.
const SECTIONS = [
  ['summary', '📊 Summary'],
  ['settlements', '💰 Settlements'],
  ['wallet', '💳 Wallet'],
  ['tax', '📋 Tax'],
];

export default function PaymentsTab() {
  const [activeSection, setActiveSection] = useState('summary');

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
