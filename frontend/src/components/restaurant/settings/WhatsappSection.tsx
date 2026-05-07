'use client';

import { useState } from 'react';
import WaConnectBanner from '../WaConnectBanner';
import MarketingNumberSection from './MarketingNumberSection';
import MarketingWaNumberSection from './MarketingWaNumberSection';
import CatalogManagementCard from './CatalogManagementCard';
import { useRestaurant } from '../../../contexts/RestaurantContext';
import { useToast } from '../../Toast';
import { disconnectWhatsapp } from '../../../api/restaurant';
import type { Restaurant, WabaAccount } from '../../../types';

interface WabaAccountExtra extends WabaAccount {
  is_linked?: boolean;
  phone?: string;
  phone_display?: string;
  name?: string;
}

interface RestaurantWithWaba extends Restaurant {
  waba_accounts?: WabaAccountExtra[];
}

interface DisconnectResponse { success?: boolean; error?: string }

interface PillMeta { bg: string; fg: string; label: string }

const QUALITY_PILL_COLORS: Record<string, PillMeta> = {
  GREEN:  { bg: 'rgba(22,163,74,.10)', fg: 'var(--gb-green-600, #15803d)', label: 'GREEN' },
  YELLOW: { bg: 'rgba(217,119,6,.10)', fg: 'var(--gb-amber-600, #b45309)', label: 'YELLOW' },
  RED:    { bg: 'rgba(220,38,38,.10)', fg: 'var(--gb-red-600,   #b91c1c)', label: 'RED' },
};

interface QualityValueProps { value?: string }

function QualityValue({ value }: QualityValueProps) {
  if (!value) return <span className="text-dim">—</span>;
  const upper = String(value).toUpperCase();
  const pill = QUALITY_PILL_COLORS[upper];
  if (!pill) return <span>{value}</span>;
  return (
    <span
      className="inline-block py-[0.15rem] px-2 rounded-md text-[0.75rem] font-semibold"
      // GREEN/YELLOW/RED Meta quality-rating palette comes from the
      // QUALITY_PILL_COLORS map at runtime — Tailwind can't pre-bake the
      // alpha-tinted backgrounds.
      style={{ background: pill.bg, color: pill.fg }}
    >
      {pill.label}
    </span>
  );
}

interface StatusBoxProps { dot: string; label: string; sub: string }

function StatusBox({ dot, label, sub }: StatusBoxProps) {
  return (
    <div className="flex items-center gap-[0.8rem] py-[0.7rem] px-4 rounded-lg bg-surface2 mb-4">
      <span
        className="w-[10px] h-[10px] rounded-full shrink-0"
        // dot colour comes from the caller (ef4444 / f59e0b / 22c55e
        // depending on connection state) — runtime value.
        style={{ background: dot }}
      />
      <div>
        <div className="font-semibold text-[0.88rem]">{label}</div>
        <div className="text-[0.78rem] text-dim">{sub}</div>
      </div>
    </div>
  );
}

export default function WhatsappSection() {
  const { restaurant, loading, refetch } = useRestaurant();
  const { showToast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [disconnecting, setDisconnecting] = useState<boolean>(false);

  const r: RestaurantWithWaba = (restaurant as RestaurantWithWaba) || {};
  const waAccounts: WabaAccountExtra[] = Array.isArray(r.waba_accounts) ? r.waba_accounts : [];
  const fullyConnected = !!r.whatsapp_connected || waAccounts.length > 0;
  const brokenConnection = !fullyConnected && !!r.meta_user_id;

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const resp = (await disconnectWhatsapp()) as DisconnectResponse | null;
      if (resp?.success) {
        showToast('WhatsApp Business disconnected', 'success');
        setConfirmOpen(false);
        await refetch();
      } else {
        showToast(resp?.error || 'Disconnect failed', 'error');
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Disconnect failed', 'error');
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading && !restaurant) {
    return (
      <div className="card">
        <div className="ch"><h3>WhatsApp Connection</h3></div>
        <div className="cb"><div className="text-dim p-2">Loading…</div></div>
      </div>
    );
  }

  let dot = '#ef4444';
  let label = 'Not connected';
  let sub = 'Connect your WhatsApp Business account to start receiving orders';
  if (fullyConnected) {
    dot = '#22c55e';
    label = 'Connected';
    const primary = waAccounts.find((a) => a.is_linked) || waAccounts[0];
    if (primary && (primary.phone || primary.phone_display)) {
      sub = primary.phone || primary.phone_display || sub;
    } else if (waAccounts.length) {
      sub = waAccounts.map((a) => a.name || a.waba_id).join(', ');
    } else {
      sub = 'WhatsApp Business account linked';
    }
  } else if (brokenConnection) {
    dot = '#f59e0b';
    label = 'Connection needs repair';
    sub = 'Your previous WhatsApp Business connection is no longer active. Click below to reconnect.';
  }

  return (
    <>
    <div className="card mb-[1.2rem]">
      <div className="ch"><h3>WhatsApp Connection</h3></div>
      <div className="cb">
        <StatusBox dot={dot} label={label} sub={sub} />

        {fullyConnected && waAccounts.length > 0 && (
          <div className="mb-4 border border-rim rounded-lg bg-panel">
            {waAccounts.map((a, i) => (
              <div
                key={a.waba_id || i}
                className={`py-[0.7rem] px-4 grid grid-cols-[minmax(120px,28%)_1fr] gap-x-[0.8rem] gap-y-[0.35rem] text-[0.82rem] ${
                  i === 0 ? '' : 'border-t border-rim'
                }`}
              >
                <span className="text-dim">WABA ID</span>
                <span
                  title={a.waba_id || ''}
                  className="font-mono whitespace-nowrap overflow-hidden text-ellipsis"
                >
                  {a.waba_id || '—'}
                </span>
                <span className="text-dim">Phone Number</span>
                <span>{a.phone || a.phone_display || '—'}</span>
                {a.name ? (
                  <>
                    <span className="text-dim">Display Name</span>
                    <span>{a.name}</span>
                  </>
                ) : null}
                <span className="text-dim">Quality Rating</span>
                <span><QualityValue value={a.quality_rating} /></span>
              </div>
            ))}
          </div>
        )}

        {fullyConnected && (
          <>
            <div className="flex gap-2 flex-wrap mt-2">
              <WaConnectBanner compact onConnected={refetch} />
              <button
                type="button"
                className="btn-g btn-sm flex-1 min-w-[140px] justify-center text-[#dc2626] border-[#dc2626]"
                onClick={() => setConfirmOpen(true)}
                disabled={disconnecting}
              >
                ⛔ Disconnect
              </button>
            </div>

            {confirmOpen && (
              <div className="mt-[0.7rem] bg-[#fef2f2] border border-[#fecaca] rounded-lg p-[0.85rem]">
                <div className="text-[0.85rem] font-semibold text-[#dc2626] mb-[0.4rem]">
                  ⚠️ Disconnect WhatsApp Business?
                </div>
                <p className="text-[0.78rem] text-[#7f1d1d] mb-[0.6rem] leading-[1.45]">
                  Customers will <strong>stop being able to message your business</strong>. Incoming
                  WhatsApp messages will be ignored and no new orders will be received until you
                  reconnect.
                  <br />
                  <br />
                  Your menu, catalog, and customer history are preserved. You can reconnect to the
                  same number or a different one anytime.
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    className="btn-g btn-sm"
                    onClick={() => setConfirmOpen(false)}
                    disabled={disconnecting}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-del btn-sm"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                  >
                    {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {!fullyConnected && (
          <div className="mt-[0.4rem]">
            <WaConnectBanner onConnected={refetch} />
          </div>
        )}
      </div>
    </div>

    <CatalogManagementCard />

    {fullyConnected && <MarketingNumberSection />}
    <MarketingWaNumberSection />
    </>
  );
}
