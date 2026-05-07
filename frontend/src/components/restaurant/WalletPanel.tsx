'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getWallet, getWalletTransactions } from '../../api/restaurant';

type TransactionType =
  | 'order_payout'
  | 'topup'
  | 'refund'
  | 'deduction'
  | 'settlement_deduction'
  | 'meta_marketing_charge'
  | 'referral_commission';

const TYPE_META: Record<TransactionType, { label: string; tone: 'credit' | 'debit' }> = {
  order_payout:          { label: 'Order Payout',        tone: 'credit' },
  topup:                 { label: 'Top Up',              tone: 'credit' },
  refund:                { label: 'Refund',              tone: 'credit' },
  deduction:             { label: 'Message Charge',      tone: 'debit'  },
  settlement_deduction:  { label: 'Settlement Deduct',   tone: 'debit'  },
  meta_marketing_charge: { label: 'Campaign Charge',     tone: 'debit'  },
  referral_commission:   { label: 'Referral Commission', tone: 'debit'  },
};

const TONE_STYLES: Record<'credit' | 'debit', { bg: string; fg: string }> = {
  credit: { bg: '#ecfdf5', fg: '#065f46' },
  debit:  { bg: '#fef2f2', fg: '#991b1b' },
};

interface WalletTxn {
  _id?: string;
  type?: string;
  amount_rs?: number | string;
  description?: string;
  created_at?: string;
  reference_id?: string;
  balance_after_rs?: number | string;
}

type WalletData = Record<string, unknown>;

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' · '
    + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function rupees(n: number | string | undefined | null): string {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
}

interface WalletPanelProps {
  onClose: () => void;
}

export default function WalletPanel({ onClose }: WalletPanelProps) {
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [items, setItems] = useState<WalletTxn[]>([]);
  const [offset, setOffset] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const panelRef = useRef<HTMLElement | null>(null);

  const PAGE_SIZE = 20;

  const loadPage = useCallback(async (off: number) => {
    const data = await getWalletTransactions({ limit: PAGE_SIZE, offset: off });
    // The existing endpoint returns an array (not paginated). We infer
    // has_more from the page being full.
    const arr = (Array.isArray(data) ? data : []) as WalletTxn[];
    return { items: arr, hasMore: arr.length === PAGE_SIZE };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [w, page] = await Promise.all([getWallet(), loadPage(0)]);
        if (cancelled) return;
        setWallet((w as WalletData) || null);
        setItems(page.items);
        setHasMore(page.hasMore);
        setOffset(page.items.length);
      } catch {
        if (!cancelled) {
          setWallet(null);
          setItems([]);
          setHasMore(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadPage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  const handleLoadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await loadPage(offset);
      setItems((prev) => [...prev, ...page.items]);
      setHasMore(page.hasMore);
      setOffset(offset + page.items.length);
    } catch { /* ignore — user can retry */ }
    finally { setLoadingMore(false); }
  };

  const campaignsEnabled = Boolean(wallet?.campaigns_enabled);
  const bal = Number((wallet?.balance_rs as number | undefined) || 0);

  return (
    <div className="fixed inset-0 z-2000 bg-black/35 flex justify-end">
      <aside
        ref={panelRef}
        className="w-[min(420px,100vw)] h-full bg-white shadow-[-2px_0_16px_rgba(0,0,0,0.12)] flex flex-col"
      >
        <header className="py-[1.1rem] px-5 border-b border-[#e5e7eb] flex items-center justify-between">
          <div className="text-base font-bold">Wallet</div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="bg-transparent border-0 text-[1.4rem] leading-none cursor-pointer text-[#6b7280]"
          >
            ×
          </button>
        </header>

        <section className="p-5 bg-[linear-gradient(135deg,#ecfdf5_0%,#d1fae5_100%)] border-b border-[#e5e7eb]">
          <div className="text-[0.75rem] text-[#047857] font-semibold tracking-wider uppercase">
            Balance
          </div>
          <div className="text-[2rem] font-extrabold text-[#064e3b] mt-1">
            {loading ? '…' : rupees(bal)}
          </div>
          <div className="flex gap-5 mt-3 text-[0.78rem] text-[#065f46] flex-wrap">
            <div>
              <div className="font-semibold">Earned this month</div>
              <div>{rupees(wallet?.current_month_earnings_rs as number | undefined)}</div>
            </div>
            <div>
              <div className="font-semibold">Spent this month</div>
              <div>{rupees(wallet?.current_month_charges_rs as number | undefined)}</div>
            </div>
          </div>
          <button
            type="button"
            disabled={!campaignsEnabled}
            title={campaignsEnabled ? 'Add money' : 'Available when campaigns are active'}
            className={`mt-4 py-[0.55rem] px-4 rounded-lg border-0 text-[0.82rem] font-bold ${campaignsEnabled ? 'cursor-pointer bg-[#059669] text-white' : 'cursor-not-allowed bg-[#d1d5db] text-[#6b7280]'}`}
          >
            + Add Money
          </button>
        </section>

        <div className="flex-1 overflow-y-auto">
          <div className="pt-[0.85rem] px-5 pb-2 text-[0.72rem] font-bold text-[#6b7280] tracking-wider uppercase">
            Transactions
          </div>

          {loading && (
            <div className="p-5 text-[#6b7280] text-[0.85rem]">Loading…</div>
          )}

          {!loading && items.length === 0 && (
            <div className="p-5 text-[#6b7280] text-[0.85rem]">
              No transactions yet. Order payouts and charges will appear here.
            </div>
          )}

          {!loading && items.map((t) => {
            const meta = (t.type && TYPE_META[t.type as TransactionType]) || { label: t.type || 'Transaction', tone: 'debit' as const };
            const badge = TONE_STYLES[meta.tone];
            const isCredit = meta.tone === 'credit';
            const amt = Number(t.amount_rs) || 0;
            const signed = (isCredit ? '+' : '-') + rupees(Math.abs(amt));
            return (
              <div
                key={t._id || `${t.created_at}-${t.reference_id}`}
                className="py-[0.85rem] px-5 border-b border-[#f3f4f6] flex justify-between gap-3"
              >
                <div className="min-w-0">
                  <span
                    className="inline-block text-[0.68rem] font-bold py-[0.15rem] px-2 rounded-full mb-1"
                    // bg/fg from TONE_STYLES by meta.tone at runtime
                    // (credit/debit — 2 distinct hex pairs).
                    style={{ background: badge.bg, color: badge.fg }}
                  >
                    {meta.label}
                  </span>
                  <div className="text-[0.82rem] text-[#111827] overflow-hidden text-ellipsis whitespace-nowrap">
                    {t.description || '—'}
                  </div>
                  <div className="text-[0.72rem] text-[#9ca3af] mt-[0.15rem]">
                    {formatDate(t.created_at)}
                  </div>
                </div>
                <div className="text-right whitespace-nowrap">
                  <div className={`text-[0.9rem] font-bold ${isCredit ? 'text-[#065f46]' : 'text-[#991b1b]'}`}>
                    {signed}
                  </div>
                  <div className="text-[0.7rem] text-[#9ca3af] mt-[0.15rem]">
                    Bal {rupees(t.balance_after_rs)}
                  </div>
                </div>
              </div>
            );
          })}

          {!loading && hasMore && (
            <div className="py-[0.85rem] px-5 text-center">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className={`py-2 px-4 rounded-lg border border-[#d1d5db] bg-white text-[0.8rem] font-semibold text-[#374151] ${loadingMore ? 'cursor-wait' : 'cursor-pointer'}`}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
