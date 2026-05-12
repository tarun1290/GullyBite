'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import { getReferrals } from '../../../api/restaurant';

// Marketing-page teaser. The full-featured page now lives at
// /dashboard/referrals — this slim variant only renders the four
// summary stats plus a deep-link so the marketing tab stays useful
// without duplicating the management surface.
interface ReferralsSummary {
  total?: number | string;
  converted?: number | string;
  total_order_value_rs?: number | string;
  total_referral_fee_rs?: number | string;
}

interface ReferralsResponse {
  summary?: ReferralsSummary;
}

function formatINR(n?: number | string | null): string {
  return parseFloat(String(n || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

export default function ReferralsSection() {
  const { data, loading, error, refetch } = useAnalyticsFetch<ReferralsResponse | null>(
    useCallback(() => getReferrals() as Promise<ReferralsResponse | null>, []),
    [],
  );

  if (error) {
    return (
      <div className="card mt-1.5">
        <div className="cb">
          <SectionError message={error} onRetry={refetch} />
        </div>
      </div>
    );
  }

  const summary = data?.summary || {};
  const total = Number(summary.total || 0);
  const converted = Number(summary.converted || 0);

  return (
    <div className="card">
      <div className="ch"><h3 className="m-0">Referrals summary</h3></div>
      <div className="cb">
        <div className="grid grid-cols-4 gap-2">
          <div className="stat">
            <div className="stat-l">Total</div>
            <div className="stat-v text-base">{loading && !data ? '…' : total}</div>
          </div>
          <div className="stat">
            <div className="stat-l">Converted</div>
            <div className="stat-v text-base">{loading && !data ? '…' : converted}</div>
          </div>
          <div className="stat">
            <div className="stat-l">Order Value</div>
            <div className="stat-v text-base">
              {loading && !data ? '…' : `₹${formatINR(summary.total_order_value_rs)}`}
            </div>
          </div>
          <div className="stat">
            <div className="stat-l">Commission</div>
            <div className="stat-v text-base">
              {loading && !data ? '…' : `₹${formatINR(summary.total_referral_fee_rs)}`}
            </div>
          </div>
        </div>
        <div className="mt-3">
          <Link href="/dashboard/referrals" className="text-acc text-sm">
            View all referrals →
          </Link>
        </div>
      </div>
    </div>
  );
}
