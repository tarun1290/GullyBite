'use client';

import { useCallback, useEffect, useState } from 'react';
import { getWallet } from '../../api/restaurant';
import WalletPanel from './WalletPanel';

type WalletData = Record<string, unknown>;

export default function WalletWidget() {
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [panelOpen, setPanelOpen] = useState<boolean>(false);

  const fetchWallet = useCallback(async () => {
    try {
      const data = await getWallet();
      setWallet((data as WalletData) || null);
    } catch {
      setWallet(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchWallet(); }, [fetchWallet]);

  const bal = Number((wallet?.balance_rs as number | undefined) || 0);
  const display = loading
    ? '…'
    : '₹' + Math.round(bal).toLocaleString('en-IN');

  const handleClose = () => {
    setPanelOpen(false);
    fetchWallet();
  };

  // Color cue: red under threshold, amber in small positive territory,
  // green otherwise. Matches the existing balanceColor helper in
  // WalletSection so the two views agree at a glance.
  const threshold = Number((wallet?.low_balance_threshold_rs as number | undefined) || 100);
  let color = 'var(--wa, #059669)';
  let bg = '#ecfdf5';
  let border = '#a7f3d0';
  if (bal < 0) { color = '#991b1b'; bg = '#fef2f2'; border = '#fecaca'; }
  else if (bal < threshold) { color = '#92400e'; bg = '#fffbeb'; border = '#fde68a'; }

  return (
    <>
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        title="Wallet — earnings, top-ups, and charges"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '.4rem',
          background: bg, color,
          border: `1px solid ${border}`, borderRadius: 999,
          padding: '.35rem .75rem', fontSize: '.82rem', fontWeight: 700,
          cursor: 'pointer', lineHeight: 1,
        }}
      >
        <span aria-hidden="true" style={{ fontSize: '.95rem' }}>💰</span>
        <span>{display}</span>
      </button>
      {panelOpen && <WalletPanel onClose={handleClose} />}
    </>
  );
}
