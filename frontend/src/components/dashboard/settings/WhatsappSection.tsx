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
  if (!value) return <span style={{ color: 'var(--dim)' }}>—</span>;
  const upper = String(value).toUpperCase();
  const pill = QUALITY_PILL_COLORS[upper];
  if (!pill) return <span>{value}</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '.15rem .5rem', borderRadius: 6,
      fontSize: '.75rem', fontWeight: 600, background: pill.bg, color: pill.fg,
    }}
    >
      {pill.label}
    </span>
  );
}

interface StatusBoxProps { dot: string; label: string; sub: string }

function StatusBox({ dot, label, sub }: StatusBoxProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '.8rem',
      padding: '.7rem 1rem', borderRadius: 8,
      background: 'var(--surface2,#f4f4f5)', marginBottom: '1rem',
    }}
    >
      <span style={{
        width: 10, height: 10, borderRadius: '50%',
        background: dot, flexShrink: 0,
      }}
      />
      <div>
        <div style={{ fontWeight: 600, fontSize: '.88rem' }}>{label}</div>
        <div style={{ fontSize: '.78rem', color: 'var(--dim)' }}>{sub}</div>
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
        <div className="cb"><div style={{ color: 'var(--dim)', padding: '.5rem' }}>Loading…</div></div>
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
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch"><h3>WhatsApp Connection</h3></div>
      <div className="cb">
        <StatusBox dot={dot} label={label} sub={sub} />

        {fullyConnected && waAccounts.length > 0 && (
          <div
            style={{
              marginBottom: '1rem',
              border: '1px solid var(--rim)',
              borderRadius: 8,
              background: 'var(--panel, #fff)',
            }}
          >
            {waAccounts.map((a, i) => (
              <div
                key={a.waba_id || i}
                style={{
                  padding: '.7rem 1rem',
                  borderTop: i === 0 ? 'none' : '1px solid var(--rim)',
                  display: 'grid',
                  gridTemplateColumns: 'minmax(120px, 28%) 1fr',
                  rowGap: '.35rem',
                  columnGap: '.8rem',
                  fontSize: '.82rem',
                }}
              >
                <span style={{ color: 'var(--dim)' }}>WABA ID</span>
                <span
                  title={a.waba_id || ''}
                  style={{
                    fontFamily: 'monospace',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {a.waba_id || '—'}
                </span>
                <span style={{ color: 'var(--dim)' }}>Phone Number</span>
                <span>{a.phone || a.phone_display || '—'}</span>
                {a.name ? (
                  <>
                    <span style={{ color: 'var(--dim)' }}>Display Name</span>
                    <span>{a.name}</span>
                  </>
                ) : null}
                <span style={{ color: 'var(--dim)' }}>Quality Rating</span>
                <span><QualityValue value={a.quality_rating} /></span>
              </div>
            ))}
          </div>
        )}

        {fullyConnected && (
          <>
            <div style={{
              display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginTop: '.5rem',
            }}
            >
              <WaConnectBanner compact onConnected={refetch} />
              <button
                type="button"
                className="btn-g btn-sm"
                style={{ flex: 1, minWidth: 140, justifyContent: 'center', color: '#dc2626', borderColor: '#dc2626' }}
                onClick={() => setConfirmOpen(true)}
                disabled={disconnecting}
              >
                ⛔ Disconnect
              </button>
            </div>

            {confirmOpen && (
              <div style={{
                marginTop: '.7rem', background: '#fef2f2', border: '1px solid #fecaca',
                borderRadius: 8, padding: '.85rem',
              }}
              >
                <div style={{
                  fontSize: '.85rem', fontWeight: 600, color: '#dc2626', marginBottom: '.4rem',
                }}
                >
                  ⚠️ Disconnect WhatsApp Business?
                </div>
                <p style={{
                  fontSize: '.78rem', color: '#7f1d1d', marginBottom: '.6rem', lineHeight: 1.45,
                }}
                >
                  Customers will <strong>stop being able to message your business</strong>. Incoming
                  WhatsApp messages will be ignored and no new orders will be received until you
                  reconnect.
                  <br />
                  <br />
                  Your menu, catalog, and customer history are preserved. You can reconnect to the
                  same number or a different one anytime.
                </p>
                <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
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
                    className="btn-sm"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                    style={{
                      background: '#dc2626', color: '#fff', border: 'none',
                      borderRadius: 6, padding: '.4rem .9rem', fontSize: '.8rem',
                      fontWeight: 600, cursor: disconnecting ? 'not-allowed' : 'pointer',
                      opacity: disconnecting ? 0.6 : 1,
                    }}
                  >
                    {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {!fullyConnected && (
          <div style={{ marginTop: '.4rem' }}>
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
