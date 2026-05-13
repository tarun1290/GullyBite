'use client';

import { useState } from 'react';
import BranchesSection from '../../../components/restaurant/BranchesSection';
import UsersSection from '../../../components/restaurant/UsersSection';
import { useToast } from '../../../components/Toast';
import { useRestaurant } from '../../../contexts/RestaurantContext';

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['branches', '🏪 Branches'],
  ['users', '👥 Staff / Users'],
];

export default function RestaurantPage() {
  const [activeSection, setActiveSection] = useState<string>('branches');
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
      {/* Staff App Store ID card — owner-visible recovery surface so
          staff can be reminded of the value any time. Hidden when the
          context hasn't loaded yet (initial mount) and when the slug
          field is empty for some reason; the operator can fall back
          to Settings → Business Info to inspect. */}
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

      <div className="chips chips--divided">
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
