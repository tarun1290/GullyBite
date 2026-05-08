'use client';

import { useState } from 'react';
import {
  confirmMarketingCampaign,
  type MarketingCampaignEstimate,
} from '../../../api/restaurant';

// Two-step create→confirm flow's confirmation modal. Rendered after
// POST /create returns { campaignId, estimate } so the operator can
// review the server-computed audience size + cost (which may differ
// from the wizard's client-side estimate if the customer cohort
// shifted between wizard mount and submit) before committing the
// wallet debit. Cancel dismisses the modal — the draft itself sits in
// MongoDB until the auto-journey runner sweeps it 24h later.

interface CostConfirmCardProps {
  campaignId: string;
  estimate: MarketingCampaignEstimate;
  onConfirm: (status: string, sendAt?: string) => void;
  onCancel: () => void;
}

function fmtRs(n: number): string {
  return `₹${Number(n || 0).toFixed(2)}`;
}

export default function CostConfirmCard({ campaignId, estimate, onConfirm, onCancel }: CostConfirmCardProps) {
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const proceed = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await confirmMarketingCampaign(campaignId);
      onConfirm(res.status, res.send_at);
    } catch (e: unknown) {
      const x = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(x?.response?.data?.error || x?.message || 'Confirm failed');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-r border border-rim w-[440px] max-w-[92vw] p-6 flex flex-col gap-4 shadow-default">
        <div>
          <h3 className="m-0 text-[1.05rem] font-semibold text-tx">Ready to send?</h3>
          <p className="m-0 mt-1 text-[0.82rem] text-dim">
            Review the audience and cost, then confirm to start the send.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 border border-rim rounded-lg p-3">
          <Stat label="Recipients" value={estimate.recipient_count.toLocaleString('en-IN')} />
          <Stat label="Cost per message" value={fmtRs(estimate.cost_per_message_rs)} />
          <Stat label="Total cost" value={fmtRs(estimate.total_cost_rs)} highlight />
          <Stat label="Wallet balance" value={fmtRs(estimate.wallet_balance_rs)} />
        </div>

        {estimate.markup_multiplier !== undefined && estimate.markup_multiplier > 1.0 && (
          <div className="text-[0.78rem] text-dim -mt-2">
            Includes platform fee ({estimate.markup_multiplier}×)
          </div>
        )}

        {!estimate.wallet_sufficient && (
          <div className="flex items-start gap-2 py-2 px-3 bg-amber-50 border border-amber-300 rounded-lg text-[0.82rem] text-amber-900">
            <span className="text-[1rem] leading-none mt-[2px]">⚠️</span>
            <div>
              <strong>Insufficient wallet balance.</strong>{' '}
              Top up the wallet before proceeding — the send will fail mid-batch when the balance runs out.
            </div>
          </div>
        )}

        {err && (
          <div className="text-[0.82rem] text-red-600 bg-red-50 border border-red-200 rounded-lg py-2 px-3">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="btn-g btn-sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-p btn-sm"
            onClick={proceed}
            disabled={busy}
          >
            {busy ? 'Confirming…' : 'Proceed'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface StatProps { label: string; value: string; highlight?: boolean }
function Stat({ label, value, highlight }: StatProps) {
  return (
    <div className="flex flex-col gap-[0.15rem]">
      <span className="text-[0.7rem] text-dim uppercase tracking-[0.04em]">{label}</span>
      <strong className={`text-[0.95rem] ${highlight ? 'text-acc' : 'text-tx'}`}>{value}</strong>
    </div>
  );
}
