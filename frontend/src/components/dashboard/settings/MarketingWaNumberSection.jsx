import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../Toast.jsx';
import {
  getMarketingWaStatus,
  saveMarketingWaNumber,
  getWallet,
} from '../../../api/restaurant.js';

// Marketing WhatsApp Number — manual entry path (Phone Number ID +
// WABA ID). Separate from the picker in MarketingNumberSection.jsx,
// which selects from a linked WABA. This flow is used during the
// campaigns rollout while campaigns_enabled is off — the entire
// surface is gated by a Coming Soon overlay until the flag flips.

const BADGES = {
  not_configured: { label: 'Not configured', bg: '#e5e7eb', fg: '#374151', border: '#d1d5db' },
  pending:        { label: 'Pending verification', bg: '#fef3c7', fg: '#92400e', border: '#fde68a' },
  active:         { label: 'Active', bg: '#d1fae5', fg: '#065f46', border: '#a7f3d0' },
  flagged:        { label: 'Action required', bg: '#ffedd5', fg: '#9a3412', border: '#fed7aa' },
  error:          { label: 'Verification failed', bg: '#fee2e2', fg: '#991b1b', border: '#fecaca' },
};

function StatusBadge({ status }) {
  const b = BADGES[status] || BADGES.not_configured;
  return (
    <span style={{
      display: 'inline-block',
      marginLeft: '.6rem',
      padding: '.18rem .55rem',
      borderRadius: 999,
      background: b.bg, color: b.fg, border: `1px solid ${b.border}`,
      fontSize: '.7rem', fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '.04em',
    }}>
      {b.label}
    </span>
  );
}

export default function MarketingWaNumberSection() {
  const { showToast } = useToast();
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [status, setStatus] = useState('not_configured');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const [campaignsEnabled, setCampaignsEnabled] = useState(false);
  const pollTimerRef = useRef(null);
  const pollDeadlineRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [mw, wallet] = await Promise.all([
          getMarketingWaStatus().catch(() => null),
          getWallet().catch(() => ({})),
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
        const mw = await getMarketingWaStatus();
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
      const resp = await saveMarketingWaNumber({
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim(),
      });
      setStatus(resp?.status || 'pending');
      showToast('Marketing number saved — verifying…', 'success');
      startPolling();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const disabled = !campaignsEnabled;

  return (
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch" style={{ display: 'flex', alignItems: 'center' }}>
        <h3>Marketing WhatsApp Number</h3>
        {loaded && <StatusBadge status={status} />}
      </div>
      <div className="cb">
        {disabled && (
          <div className="notice wa" style={{ marginBottom: '1rem' }}>
            <div className="notice-ico">✨</div>
            <div className="notice-body">
              <h4>Coming Soon</h4>
              <p>
                Marketing campaigns aren't active on your account yet. You can still prepare your
                WhatsApp Business number details — saving is disabled until campaigns go live.
              </p>
            </div>
          </div>
        )}

        <div style={{
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'not-allowed' : 'auto',
          pointerEvents: disabled ? 'none' : 'auto',
        }}>
          <p style={{ fontSize: '.82rem', color: 'var(--dim)', marginTop: 0, marginBottom: '.9rem', lineHeight: 1.5 }}>
            The number your customers will receive marketing messages from. Add your WhatsApp
            Business number details below.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '.9rem' }}>
            <div>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '.82rem', marginBottom: '.3rem' }}>
                Phone Number ID
              </label>
              <input
                type="text"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                placeholder="Enter your Phone Number ID"
                disabled={saving || disabled}
                style={{
                  width: '100%', maxWidth: 420,
                  padding: '.45rem .6rem',
                  border: '1px solid var(--rim)',
                  borderRadius: 6, fontSize: '.85rem',
                }}
              />
              <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.25rem' }}>
                Found in Meta Business Manager → WhatsApp Accounts → your number → API Setup
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '.82rem', marginBottom: '.3rem' }}>
                WABA ID
              </label>
              <input
                type="text"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="Enter your WABA ID"
                disabled={saving || disabled}
                style={{
                  width: '100%', maxWidth: 420,
                  padding: '.45rem .6rem',
                  border: '1px solid var(--rim)',
                  borderRadius: 6, fontSize: '.85rem',
                }}
              />
              <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.25rem' }}>
                Found in Meta Business Manager → WhatsApp Accounts
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setHintOpen((v) => !v)}
                style={{
                  background: 'transparent', border: 'none',
                  color: '#0369a1', cursor: 'pointer', padding: 0,
                  fontSize: '.78rem', fontWeight: 600,
                }}
              >
                {hintOpen ? '▾ Where do I find these?' : '▸ Where do I find these?'}
              </button>
              {hintOpen && (
                <div style={{
                  marginTop: '.45rem',
                  padding: '.7rem .85rem',
                  background: '#f0f9ff',
                  border: '1px solid #bae6fd',
                  borderRadius: 6,
                  fontSize: '.78rem', color: '#0c4a6e', lineHeight: 1.5,
                }}>
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
