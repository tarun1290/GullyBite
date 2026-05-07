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
        className="inline-flex items-center gap-[0.4rem] border rounded-full py-[0.35rem] px-3 text-[0.82rem] font-bold cursor-pointer leading-none"
        // bg / color / border-color are runtime-driven by wallet balance
        // (negative → red, low → amber, otherwise green) — matches the
        // balanceColor helper in WalletSection.
        style={{ background: bg, color, borderColor: border }}
      >
        <span aria-hidden="true" className="text-[0.95rem]">💰</span>
        <span>{display}</span>
      </button>
      {panelOpen && <WalletPanel onClose={handleClose} />}
    </>
  );
}
