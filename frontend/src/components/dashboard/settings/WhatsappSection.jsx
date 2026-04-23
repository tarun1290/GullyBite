import { useState } from 'react';
import WaConnectBanner from '../WaConnectBanner.jsx';
import MarketingNumberSection from './MarketingNumberSection.jsx';
import MarketingWaNumberSection from './MarketingWaNumberSection.jsx';
import { useRestaurant } from '../../../contexts/RestaurantContext.jsx';
import { useToast } from '../../Toast.jsx';
import { disconnectWhatsapp } from '../../../api/restaurant.js';

// Mirrors loadProfile()'s WhatsApp-status block + doDisconnectWhatsapp() in
// legacy settings.js:624-677 + 1656-1688. Three states:
//   1. fullyConnected     — show Change + Disconnect (with inline two-click confirm)
//   2. brokenConnection   — meta_user_id exists but whatsapp_connected=false → Reconnect
//   3. notConnected       — render WaConnectBanner (reused, non-compact)
// Change + (initial) Connect both delegate to WaConnectBanner's OAuth flow.

function StatusBox({ dot, label, sub }) {
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const r = restaurant || {};
  const waAccounts = Array.isArray(r.waba_accounts) ? r.waba_accounts : [];
  const fullyConnected = !!r.whatsapp_connected || waAccounts.length > 0;
  const brokenConnection = !fullyConnected && !!r.meta_user_id;

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const resp = await disconnectWhatsapp();
      if (resp?.success) {
        showToast('WhatsApp Business disconnected', 'success');
        setConfirmOpen(false);
        await refetch();
      } else {
        showToast(resp?.error || 'Disconnect failed', 'error');
      }
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Disconnect failed', 'error');
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
      sub = primary.phone || primary.phone_display;
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
                <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
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

    {fullyConnected && <MarketingNumberSection />}
    <MarketingWaNumberSection />
    </>
  );
}

