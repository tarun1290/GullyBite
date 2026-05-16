'use client';

import { useState } from 'react';
import CouponTemplatesTab from './CouponTemplatesTab';
import CouponCodesTab from './CouponCodesTab';

// Two-tab page. Templates = the original /admin/coupons content
// (coupon-template CRUD, verbatim). Codes = the former
// /admin/coupon-codes page, folded in here verbatim (route removed,
// redirects to /admin/coupons via proxy.ts). Chip tab pattern matches
// the app-standard used by the marketing / platform pages — coupons
// had no prior tab control of its own.
type TabKey = 'templates' | 'codes';

const TABS: ReadonlyArray<readonly [TabKey, string]> = [
  ['templates', 'Templates'],
  ['codes', 'Codes'],
];

export default function AdminCouponsPage() {
  const [tab, setTab] = useState<TabKey>('templates');

  return (
    <div id="pg-coupons-wrap">
      <div className="chips chips--divided mb-4">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? 'chip on' : 'chip'}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'templates' ? <CouponTemplatesTab /> : <CouponCodesTab />}
    </div>
  );
}
