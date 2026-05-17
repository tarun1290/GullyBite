'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import BusinessInfoSection from '../../../components/restaurant/settings/BusinessInfoSection';
import PricingSection from '../../../components/restaurant/settings/PricingSection';
import NotificationSection from '../../../components/restaurant/settings/NotificationSection';
import WhatsappSection from '../../../components/restaurant/settings/WhatsappSection';
import IntegrationsSection from '../../../components/restaurant/settings/IntegrationsSection';
import PasswordSection from '../../../components/restaurant/settings/PasswordSection';
import BranchesSection from '../../../components/restaurant/BranchesSection';
import UsersSection from '../../../components/restaurant/UsersSection';
import { useToast } from '../../../components/Toast';
import { useRestaurant } from '../../../contexts/RestaurantContext';

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['business', '🏢 Business'],
  ['pricing', '💰 Pricing'],
  ['notifications', '🔔 Notifications'],
  ['whatsapp', '💬 WhatsApp'],
  ['integrations', '🔗 Integrations'],
  ['security', '🔒 Security'],
  ['branches', '🏪 Branches'],
  ['team', '👥 Team'],
];

// Valid tab keys derived from the chip nav above — single source of
// truth, so adding a SECTIONS entry automatically makes ?section= for
// it deep-linkable without touching this set.
const VALID_SECTIONS = new Set<string>(SECTIONS.map(([v]) => v));

function SettingsPageInner() {
  const searchParams = useSearchParams();
  // Initial tab only: read ?section= once on mount and validate against
  // the known keys; anything missing or unknown falls back to 'business'.
  // Chip clicks still drive activeSection normally afterwards.
  const [activeSection, setActiveSection] = useState<string>(() => {
    const requested = searchParams.get('section');
    return requested && VALID_SECTIONS.has(requested) ? requested : 'business';
  });
  const { restaurant } = useRestaurant();
  const { showToast } = useToast();
  const [storeIdCopied, setStoreIdCopied] = useState<boolean>(false);

  // Restaurant.store_slug isn't declared on the canonical Restaurant
  // type (it carries a permissive `[k: string]: unknown` index signature)
  // — narrow with a local cast at the read site. Same pattern
  // BusinessInfoSection uses for slug surfacing.
  const storeSlug = (restaurant as { store_slug?: string | null } | null)?.store_slug || '';

  const copyStoreId = async () => {
    if (!storeSlug) return;
    try {
      await navigator.clipboard.writeText(storeSlug);
      setStoreIdCopied(true);
      window.setTimeout(() => setStoreIdCopied(false), 2000);
    } catch {
      showToast('Could not copy — select the ID manually', 'error');
    }
  };

  return (
    <div>
      <div className="flex flex-nowrap overflow-x-auto gap-2 pb-1 mb-4 border-b border-rim [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {SECTIONS.map(([v, l]) => (
          <button
            key={v}
            type="button"
            className={`flex-shrink-0 ${activeSection === v ? 'chip on' : 'chip'}`}
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

      {activeSection === 'branches' && <BranchesSection />}

      {activeSection === 'team' && (
        <div>
          {/* Staff App Store ID card — moved verbatim from the former
              standalone restaurant page; now sits at the top of the Team
              tab content. Owner-visible recovery surface so staff can be
              reminded of the value any time. Hidden when the context
              hasn't loaded yet (initial mount) and when the slug field is
              empty for some reason; the operator can fall back to
              Settings → Business to inspect. */}
          {storeSlug && (
            <div className="card mb-4">
              <div className="cb">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-[200px]">
                    <div className="text-xs text-dim uppercase tracking-[0.5px] mb-1">
                      Staff App Store ID
                    </div>
                    <div className="font-mono text-base font-semibold text-tx break-all">
                      {storeSlug}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { void copyStoreId(); }}
                    className="btn-g btn-sm"
                  >
                    {storeIdCopied ? 'Copied!' : '📋 Copy'}
                  </button>
                </div>
                <div className="text-xs text-dim mt-2">
                  Staff and managers need this value, their Login ID, and their PIN to log into the staff app.
                </div>
              </div>
            </div>
          )}

          <UsersSection />
        </div>
      )}
    </div>
  );
}

// useSearchParams() requires a Suspense boundary on prerendered routes
// (Next 16 — see node_modules/next/dist/docs/.../use-search-params.md).
// This page is statically prerendered, so the hook-using component must
// sit inside <Suspense>.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}
