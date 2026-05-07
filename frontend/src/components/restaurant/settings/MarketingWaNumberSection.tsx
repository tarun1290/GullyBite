'use client';

import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../Toast';
import {
  getMarketingWaStatus,
  saveMarketingWaNumber,
  getWallet,
} from '../../../api/restaurant';

type StatusKey = 'not_configured' | 'pending' | 'active' | 'flagged' | 'error';

interface BadgeMeta { label: string; bg: string; fg: string; border: string }

const BADGES: Record<StatusKey, BadgeMeta> = {
  not_configured: { label: 'Not configured', bg: '#e5e7eb', fg: '#374151', border: '#d1d5db' },
  pending:        { label: 'Pending verification', bg: '#fef3c7', fg: '#92400e', border: '#fde68a' },
  active:         { label: 'Active', bg: '#d1fae5', fg: '#065f46', border: '#a7f3d0' },
  flagged:        { label: 'Action required', bg: '#ffedd5', fg: '#9a3412', border: '#fed7aa' },
  error:          { label: 'Verification failed', bg: '#fee2e2', fg: '#991b1b', border: '#fecaca' },
};

interface MarketingWaStatus {
  phone_number_id?: string;
  waba_id?: string;
  status?: string;
}

interface WalletWithCampaigns {
  campaigns_enabled?: boolean;
}

interface SaveResponse {
  status?: string;
}

interface StatusBadgeProps { status: string }

function StatusBadge({ status }: StatusBadgeProps) {
  const key = (status as StatusKey);
  const b = BADGES[key] || BADGES.not_configured;
  return (
    <span
      className="inline-block ml-[0.6rem] py-[0.18rem] px-[0.55rem] rounded-full text-[0.7rem] font-bold uppercase tracking-[0.04em] border"
      // status-driven palette (not_configured / pending / active / flagged
      // / error) — bg / text / border each pulled from the BADGES map at
      // runtime, so Tailwind can't pre-bake the per-status hex.
      style={{ background: b.bg, color: b.fg, borderColor: b.border }}
    >
      {b.label}
    </span>
  );
}

export default function MarketingWaNumberSection() {
  const { showToast } = useToast();
  const [phoneNumberId, setPhoneNumberId] = useState<string>('');
  const [wabaId, setWabaId] = useState<string>('');
  const [status, setStatus] = useState<string>('not_configured');
  const [loaded, setLoaded] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [hintOpen, setHintOpen] = useState<boolean>(false);
  const [campaignsEnabled, setCampaignsEnabled] = useState<boolean>(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [mw, wallet] = await Promise.all([
          (getMarketingWaStatus() as Promise<MarketingWaStatus | null>).catch(() => null),
          (getWallet() as Promise<WalletWithCampaigns | null>).catch(() => null),
        ]);
        if (cancelled) return;
        if (mw) {
          setPhoneNumberId(mw.phone_number_id || '');
          setWabaId(mw.waba_id || '');
          setStatus(mw.status || 'not_configured');
        }
        setCampaignsEnabled(!!wallet?.campaigns_enabled);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const startPolling = () => {
    stopPolling();
    pollDeadlineRef.current = Date.now() + 2 * 60 * 1000;
    pollTimerRef.current = setInterval(async () => {
      if (Date.now() > pollDeadlineRef.current) { stopPolling(); return; }
      try {
        const mw = (await getMarketingWaStatus()) as MarketingWaStatus | null;
        if (mw?.status && mw.status !== 'pending') {
          setStatus(mw.status);
          stopPolling();
        }
      } catch { /* keep polling */ }
    }, 10000);
  };

  const handleSave = async () => {
    if (!phoneNumberId.trim() || !wabaId.trim()) {
      showToast('Both Phone Number ID and WABA ID are required', 'error');
      return;
    }
    setSaving(true);
    try {
      const resp = (await saveMarketingWaNumber({
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim(),
      })) as SaveResponse | null;
      setStatus(resp?.status || 'pending');
      showToast('Marketing number saved — verifying…', 'success');
      startPolling();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const disabled = !campaignsEnabled;

  return (
    <div className="card mb-[1.2rem]">
      <div className="ch flex items-center">
        <h3>Marketing WhatsApp Number</h3>
        {loaded && <StatusBadge status={status} />}
      </div>
      <div className="cb">
        {disabled && (
          <div className="notice wa mb-4">
            <div className="notice-ico">✨</div>
            <div className="notice-body">
              <h4>Coming Soon</h4>
              <p>
                Marketing campaigns aren&apos;t active on your account yet. You can still prepare your
                WhatsApp Business number details — saving is disabled until campaigns go live.
              </p>
            </div>
          </div>
        )}

        <div className={disabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''}>
          <p className="text-[0.82rem] text-dim mt-0 mb-[0.9rem] leading-normal">
            The number your customers will receive marketing messages from. Add your WhatsApp
            Business number details below.
          </p>

          <div className="flex flex-col gap-[0.9rem]">
            <div>
              <label className="block font-semibold text-[0.82rem] mb-[0.3rem]">
                Phone Number ID
              </label>
              <input
                type="text"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                placeholder="Enter your Phone Number ID"
                disabled={saving || disabled}
                className="w-full max-w-[420px] py-[0.45rem] px-[0.6rem] border border-rim rounded-md text-[0.85rem]"
              />
              <div className="text-[0.72rem] text-dim mt-1">
                Found in Meta Business Manager → WhatsApp Accounts → your number → API Setup
              </div>
            </div>

            <div>
              <label className="block font-semibold text-[0.82rem] mb-[0.3rem]">
                WABA ID
              </label>
              <input
                type="text"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="Enter your WABA ID"
                disabled={saving || disabled}
                className="w-full max-w-[420px] py-[0.45rem] px-[0.6rem] border border-rim rounded-md text-[0.85rem]"
              />
              <div className="text-[0.72rem] text-dim mt-1">
                Found in Meta Business Manager → WhatsApp Accounts
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setHintOpen((v) => !v)}
                className="bg-transparent border-0 text-[#0369a1] cursor-pointer p-0 text-[0.78rem] font-semibold"
              >
                {hintOpen ? '▾ Where do I find these?' : '▸ Where do I find these?'}
              </button>
              {hintOpen && (
                <div className="mt-[0.45rem] py-[0.7rem] px-[0.85rem] bg-[#f0f9ff] border border-[#bae6fd] rounded-md text-[0.78rem] text-[#0c4a6e] leading-normal">
                  Log in to business.facebook.com → WhatsApp Manager → select your number → you
                  will find Phone Number ID and WABA ID on the API Setup tab.
                </div>
              )}
            </div>

            <div>
              <button
                type="button"
                className="btn-p btn-sm"
                onClick={handleSave}
                disabled={saving || disabled}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
