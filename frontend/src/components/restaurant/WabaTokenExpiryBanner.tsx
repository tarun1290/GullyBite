'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getMe } from '../../api/auth';
import type { WabaAccount } from '../../types';

const DAY_MS = 86400000;
const THRESHOLD_INFO     = 45;
const THRESHOLD_WARNING  = 55;
const THRESHOLD_CRITICAL = 60;

type Level = 'info' | 'warning' | 'critical';

const STYLES: Record<Level, { background: string; borderColor: string; textColor: string; btnBackground: string }> = {
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

function levelFor(daysSinceIssued: number): Level | null {
  if (daysSinceIssued >= THRESHOLD_CRITICAL) return 'critical';
  if (daysSinceIssued >= THRESHOLD_WARNING)  return 'warning';
  if (daysSinceIssued >= THRESHOLD_INFO)     return 'info';
  return null;
}

function messageFor(level: Level, daysSinceIssued: number): string {
  // 60-day token; banner counts down to 60 then says "expired".
  const daysRemaining = Math.max(0, THRESHOLD_CRITICAL - daysSinceIssued);
  if (level === 'critical') return 'Your WhatsApp connection has expired. Service is interrupted. Reconnect now.';
  if (level === 'warning')  return `Your WhatsApp connection expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}. Reconnect now to prevent service interruption.`;
  return `Your WhatsApp connection will need renewal in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}. Reconnect to avoid service interruption.`;
}

interface DatedWaba extends WabaAccount {
  is_active?: boolean;
  updated_at?: string;
  created_at?: string;
}

function pickMostRecentActive(accounts: DatedWaba[] | undefined | null): DatedWaba | null {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const active = accounts.filter((a) => a?.is_active !== false);
  if (active.length === 0) return null;
  // Sort descending by updated_at (preferred) → created_at (fallback).
  return [...active].sort((x, y) => {
    const xt = new Date(x.updated_at || x.created_at || 0).getTime();
    const yt = new Date(y.updated_at || y.created_at || 0).getTime();
    return yt - xt;
  })[0] || null;
}

type Status = 'loading' | 'ready' | 'empty' | 'error';

export default function WabaTokenExpiryBanner() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('loading');
  const [daysSinceIssued, setDaysSinceIssued] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => {
        if (cancelled) return;
        const wabaList = me?.waba_accounts as DatedWaba[] | undefined;
        const waba = pickMostRecentActive(wabaList);
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
      className="flex items-center gap-3 py-3 px-6 border-b text-[0.85rem]"
      // bg / borderColor / text colour come from the STYLES palette by
      // level (info/warning/critical) at runtime — three distinct sets.
      style={{
        background: palette.background,
        borderBottomColor: palette.borderColor,
        color: palette.textColor,
      }}
    >
      <span className="text-[1.05rem] shrink-0" aria-hidden="true">{icon}</span>
      <span className="flex-1 leading-[1.4]">{messageFor(level, daysSinceIssued)}</span>
      <button
        type="button"
        onClick={() => router.push('/dashboard/settings?section=whatsapp')}
        className="shrink-0 text-white border-0 py-2 px-4 rounded-md font-semibold text-[0.8rem] cursor-pointer whitespace-nowrap"
        // btnBackground from the same level-keyed palette.
        style={{ background: palette.btnBackground }}
      >
        Reconnect WhatsApp
      </button>
    </div>
  );
}
