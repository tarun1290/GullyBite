'use client';

import Card from '../../../components/Card';

// Placeholder. The platform analytics content moved to the canonical
// /admin/platform-analytics page (this route previously duplicated it
// verbatim). This route is intentionally kept alive but is no longer in
// the admin sidebar; it will host the platform-wide campaign blast tool
// when that's built. No data fetching.
export default function AdminPlatformMarketingPage() {
  return (
    <div id="tab-platform-marketing">
      <Card title="Campaign Blasts">
        <p className="py-4 text-slate-400 text-base">
          Platform-wide campaign blast tool — coming soon.
        </p>
      </Card>
    </div>
  );
}
