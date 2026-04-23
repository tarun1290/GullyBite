import { useEffect, useState } from 'react';
import { getMe } from '../../../api/auth.js';

// Read-only WABA details card. Renders below the WhatsApp Connection card
// and above the Meta Catalog card in Settings → WhatsApp.
//
// Self-contained: fetches /auth/me directly on mount and stores the result
// in component-local state. INTENTIONALLY bypasses useRestaurant() and any
// other shared context — a prior attempt that read from the shared hook
// failed to render in production for unclear reasons. This component owns
// its own data path so the render is deterministic from network response.
//
// No mutations, no edit actions, no toast — pure display.

const QUALITY_PILL_COLORS = {
  GREEN:  { bg: 'rgba(22,163,74,.10)', fg: 'var(--gb-green-600, #15803d)', label: 'GREEN' },
  YELLOW: { bg: 'rgba(217,119,6,.10)', fg: 'var(--gb-amber-600, #b45309)', label: 'YELLOW' },
  RED:    { bg: 'rgba(220,38,38,.10)', fg: 'var(--gb-red-600,   #b91c1c)', label: 'RED' },
};

function QualityValue({ value }) {
  if (!value) return <span style={{ color: 'var(--dim)' }}>—</span>;
  const upper = String(value).toUpperCase();
  const pill = QUALITY_PILL_COLORS[upper];
  if (!pill) return <span>{value}</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '.1rem .5rem', borderRadius: 999,
      fontSize: '.74rem', fontWeight: 600, background: pill.bg, color: pill.fg,
    }}
    >
      {pill.label}
    </span>
  );
}

function InfoRow({ label, children }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'minmax(140px, 30%) 1fr',
      gap: '0.75rem', padding: '0.4rem 0', fontSize: '0.86rem',
    }}
    >
      <span style={{ color: 'var(--dim)' }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

export default function WabaDetailsCard() {
  const [status, setStatus] = useState('loading');
  const [data, setData] = useState([]);
  const [errorMsg, setErrorMsg] = useState(null);

  const load = async () => {
    setStatus('loading');
    setErrorMsg(null);
    try {
      const me = await getMe();
      const accounts = Array.isArray(me?.waba_accounts) ? me.waba_accounts : [];
      setData(accounts);
      setStatus(accounts.length > 0 ? 'connected' : 'empty');
    } catch (e) {
      const code = e?.response?.status;
      if (code === 401) setErrorMsg('Session expired, please refresh');
      else setErrorMsg("Couldn't load account details");
      setStatus('error');
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return (
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch"><h3>WhatsApp Business Account</h3></div>
      <div className="cb">
        {status === 'loading' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '.6rem',
            padding: '1rem 0', color: 'var(--dim)',
          }}
          >
            <span className="spin" aria-hidden="true" />
            <span>Loading WhatsApp account details…</span>
          </div>
        )}

        {status === 'error' && (
          <div style={{
            padding: '.75rem .9rem', background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 8, color: '#b91c1c', fontSize: '.84rem',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.6rem',
          }}
          >
            <span>{errorMsg}</span>
            <button type="button" className="btn-g btn-sm" onClick={load}>Retry</button>
          </div>
        )}

        {status === 'empty' && (
          <div style={{ padding: '.5rem 0', color: 'var(--dim)', fontSize: '.86rem' }}>
            No WhatsApp Business account connected. Connect your account above to see details here.
          </div>
        )}

        {status === 'connected' && data.map((a, i) => (
          <div
            key={a.waba_id || i}
            style={{
              padding: '0.5rem 0',
              borderTop: i === 0 ? 'none' : '1px solid var(--rim)',
              marginTop: i === 0 ? 0 : '.5rem',
            }}
          >
            <InfoRow label="Business Account ID">
              <span
                title={a.waba_id}
                style={{
                  fontFamily: 'monospace', display: 'inline-block', maxWidth: '100%',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  verticalAlign: 'bottom',
                }}
              >
                {a.waba_id || '—'}
              </span>
            </InfoRow>
            <InfoRow label="Phone Number">
              {a.phone_display || a.phone || '—'}
            </InfoRow>
            <InfoRow label="Display Name">
              {a.display_name || a.name || '—'}
            </InfoRow>
            <InfoRow label="Quality Rating">
              <QualityValue value={a.quality_rating} />
            </InfoRow>
          </div>
        ))}
      </div>
    </div>
  );
}
