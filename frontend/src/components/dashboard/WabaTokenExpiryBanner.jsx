import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMe } from '../../api/auth.js';

// Dashboard-wide banner that warns when the per-WABA Embedded Signup token
// is approaching its 60-day expiry. Temporary measure — when Tech Provider
// approval lands and the codebase moves to non-expiring SYSTEM_USER tokens,
// this whole component (and its mount in DashboardLayout) gets deleted.
//
// Self-contained — calls getMe() directly on mount instead of consuming
// useRestaurant(). Mirrors the pattern the deleted WabaDetailsCard used,
// keeping the banner's data path independent of any shared context that
// might not surface waba_accounts deterministically.
//
// KNOWN LIMITATION: the /auth/me projection currently exposes created_at
// but NOT updated_at on waba_accounts rows. The spec calls for updated_at
// (which advances on every Embedded Signup re-OAuth, including reconnect-
// to-same-number). The component reads updated_at and falls back to
// created_at when absent. For restaurants who reconnected after their
// initial signup, the banner may fire ~N days early until the backend
// projection adds updated_at (one-line additive change in two files).

const DAY_MS = 86400000;
const THRESHOLD_INFO     = 45;
const THRESHOLD_WARNING  = 55;
const THRESHOLD_CRITICAL = 60;

const STYLES = {
  info: {
    background: '#FEF3C7', borderColor: '#F59E0B', textColor: '#78350F',
    btnBackground: '#F59E0B',
  },
  warning: {
    background: '#FED7AA', borderColor: '#EA580C', textColor: '#7C2D12',
    btnBackground: '#EA580C',
  },
  critical: {
    background: '#FEE2E2', borderColor: '#DC2626', textColor: '#7F1D1D',
    btnBackground: '#DC2626',
  },
};

function levelFor(daysSinceIssued) {
  if (daysSinceIssued >= THRESHOLD_CRITICAL) return 'critical';
  if (daysSinceIssued >= THRESHOLD_WARNING)  return 'warning';
  if (daysSinceIssued >= THRESHOLD_INFO)     return 'info';
  return null;
}

function messageFor(level, daysSinceIssued) {
  // 60-day token; banner counts down to 60 then says "expired".
  const daysRemaining = Math.max(0, THRESHOLD_CRITICAL - daysSinceIssued);
  if (level === 'critical') return 'Your WhatsApp connection has expired. Service is interrupted. Reconnect now.';
  if (level === 'warning')  return `Your WhatsApp connection expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}. Reconnect now to prevent service interruption.`;
  return `Your WhatsApp connection will need renewal in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}. Reconnect to avoid service interruption.`;
}

function pickMostRecentActive(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const active = accounts.filter((a) => a?.is_active !== false);
  if (active.length === 0) return null;
  // Sort descending by updated_at (preferred) → created_at (fallback).
  return [...active].sort((x, y) => {
    const xt = new Date(x.updated_at || x.created_at || 0).getTime();
    const yt = new Date(y.updated_at || y.created_at || 0).getTime();
    return yt - xt;
  })[0];
}

export default function WabaTokenExpiryBanner() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('loading');
  const [daysSinceIssued, setDaysSinceIssued] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => {
        if (cancelled) return;
        const waba = pickMostRecentActive(me?.waba_accounts);
        if (!waba) { setStatus('empty'); return; }
        const issuedRaw = waba.updated_at || waba.created_at;
        if (!issuedRaw) { setStatus('empty'); return; }
        const issuedAt = new Date(issuedRaw).getTime();
        if (Number.isNaN(issuedAt)) { setStatus('empty'); return; }
        const days = Math.floor((Date.now() - issuedAt) / DAY_MS);
        setDaysSinceIssued(Math.max(0, days));
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => { cancelled = true; };
  }, []);

  // 4 states: loading, error, empty, ready. Only 'ready' may render — and
  // even then, only if the threshold puts us at info or worse.
  if (status !== 'ready') return null;
  const level = levelFor(daysSinceIssued);
  if (!level) return null;

  const palette = STYLES[level];
  const icon = level === 'info' ? 'ℹ' : '⚠';

  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'center', gap: '.75rem',
        padding: '0.75rem 1.5rem',
        background: palette.background,
        borderBottom: `1px solid ${palette.borderColor}`,
        color: palette.textColor,
        fontSize: '.85rem',
      }}
    >
      <span style={{ fontSize: '1.05rem', flexShrink: 0 }} aria-hidden="true">{icon}</span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{messageFor(level, daysSinceIssued)}</span>
      <button
        type="button"
        onClick={() => navigate('/dashboard/settings?section=whatsapp')}
        style={{
          flexShrink: 0,
          background: palette.btnBackground, color: '#fff', border: 'none',
          padding: '0.5rem 1rem', borderRadius: 6,
          fontWeight: 600, fontSize: '.8rem', cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        Reconnect WhatsApp
      </button>
    </div>
  );
}
