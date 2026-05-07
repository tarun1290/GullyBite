'use client';

import { useCallback, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import { useToast } from '../../Toast';
import {
  getWallet,
  getWalletTransactions,
  topUpWallet,
} from '../../../api/restaurant';

const RAZORPAY_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
const TOPUP_PRESETS: ReadonlyArray<number> = [100, 200, 500, 1000];

const TYPE_ICO: Record<string, string> = {
  topup: '✅',
  deduction: '📤',
  settlement_deduction: '📋',
  refund: '↩️',
  order_payout: '💰',
  meta_marketing_charge: '📣',
  referral_commission: '🤝',
};

const TYPE_LABEL: Record<string, string> = {
  topup: 'Top Up',
  deduction: 'Message Charge',
  settlement_deduction: 'Settlement Deduct',
  refund: 'Refund',
  order_payout: 'Order Payout',
  meta_marketing_charge: 'Campaign Charge',
  referral_commission: 'Referral Commission',
};

interface WalletData {
  balance_rs?: number | string;
  low_balance_threshold_rs?: number | string;
  monthly_spend_rs?: number | string;
  status?: string;
  current_month_earnings_rs?: number | string;
  current_month_message_charges_rs?: number | string;
  current_month_campaign_charges_rs?: number | string;
  current_month_referral_charges_rs?: number | string;
}

interface WalletTxn {
  id?: string;
  _id?: string;
  type?: string;
  description?: string;
  amount_rs?: number;
  balance_after_rs?: number | string;
  created_at?: string;
}

interface TopupResponse {
  razorpay_order_id?: string;
  key_id?: string;
}

interface RazorpayHandlerArgs { razorpay_payment_id?: string; razorpay_order_id?: string; razorpay_signature?: string }
interface RazorpayOpts {
  key?: string;
  amount: number;
  currency: string;
  order_id?: string;
  name: string;
  description: string;
  handler: (response: RazorpayHandlerArgs) => void;
  theme?: { color?: string };
}
interface RazorpayInstance { open: () => void }
type RazorpayCtor = new (opts: RazorpayOpts) => RazorpayInstance;

type RazorpayWindow = Window & { Razorpay?: RazorpayCtor };

function loadRazorpayScript(): Promise<RazorpayCtor> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('No window'));
    const w = window as RazorpayWindow;
    if (w.Razorpay) return resolve(w.Razorpay);
    const existing = document.querySelector(`script[src="${RAZORPAY_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => {
        const ctor = (window as RazorpayWindow).Razorpay;
        if (ctor) resolve(ctor); else reject(new Error('Razorpay script loaded but constructor missing'));
      });
      existing.addEventListener('error', () => reject(new Error('Razorpay script failed to load')));
      return undefined;
    }
    const s = document.createElement('script');
    s.src = RAZORPAY_SRC;
    s.async = true;
    s.onload = () => {
      const ctor = (window as RazorpayWindow).Razorpay;
      if (ctor) resolve(ctor); else reject(new Error('Razorpay script loaded but constructor missing'));
    };
    s.onerror = () => reject(new Error('Razorpay script failed to load'));
    document.head.appendChild(s);
    return undefined;
  });
}

function formatTxnDate(d?: string): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function balanceColorClass(bal: number, threshold: number): string {
  if (bal > threshold) return 'text-wa';
  if (bal > 0) return 'text-[#d97706]';
  return 'text-red';
}

export default function WalletSection() {
  const { showToast } = useToast();
  const [showTopup, setShowTopup] = useState<boolean>(false);
  const [customAmt, setCustomAmt] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const walletQ = useAnalyticsFetch<WalletData | null>(
    useCallback(() => getWallet() as Promise<WalletData | null>, []),
    [],
  );
  const txnsQ = useAnalyticsFetch<WalletTxn[] | null>(
    useCallback(() => getWalletTransactions({ limit: 20 }) as Promise<WalletTxn[] | null>, []),
    [],
  );

  const w: WalletData = walletQ.data || {};
  const bal = parseFloat(String(w.balance_rs ?? '0')) || 0;
  const threshold = Number(w.low_balance_threshold_rs) || 100;
  const monthly = parseFloat(String(w.monthly_spend_rs ?? '0')) || 0;
  const active = w.status === 'active';

  const monthEarnings  = parseFloat(String(w.current_month_earnings_rs ?? '0')) || 0;
  const monthMessages  = parseFloat(String(w.current_month_message_charges_rs ?? '0')) || 0;
  const monthCampaigns = parseFloat(String(w.current_month_campaign_charges_rs ?? '0')) || 0;
  const monthReferrals = parseFloat(String(w.current_month_referral_charges_rs ?? '0')) || 0;

  const txns: WalletTxn[] = Array.isArray(txnsQ.data) ? txnsQ.data : [];

  const doTopup = async (amt: number) => {
    if (busy) return;
    if (!amt || amt < 100 || amt > 10000) {
      showToast('Amount must be ₹100 – ₹10,000', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = (await topUpWallet({ amount_rs: amt })) as TopupResponse | null;
      if (!r?.razorpay_order_id) {
        showToast('Failed to create payment', 'error');
        return;
      }
      const Razorpay = await loadRazorpayScript();
      const opts: RazorpayOpts = {
        amount: amt * 100,
        currency: 'INR',
        order_id: r.razorpay_order_id,
        name: 'GullyBite',
        description: 'Messaging Wallet Top-Up',
        handler() {
          showToast('Payment received! Wallet will be credited shortly.', 'success');
          setShowTopup(false);
          setCustomAmt('');
          setTimeout(() => {
            walletQ.refetch();
            txnsQ.refetch();
          }, 3000);
        },
        theme: { color: '#25D366' },
      };
      if (r.key_id) opts.key = r.key_id;
      const rzp = new Razorpay(opts);
      rzp.open();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Top-up failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card mb-[1.2rem]">
      <div className="ch justify-between">
        <h3>Wallet</h3>
        <button type="button" className="btn-p btn-sm" onClick={() => setShowTopup(true)}>
          Top Up
        </button>
      </div>
      <div className="cb">
        {walletQ.error ? (
          <SectionError message={walletQ.error} onRetry={walletQ.refetch} />
        ) : (
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <div className="text-[0.75rem] text-dim mb-[0.2rem]">Current Balance</div>
              <div id="wlt-balance" className={`text-[1.5rem] font-bold ${balanceColorClass(bal, threshold)}`}>
                {walletQ.loading && !walletQ.data ? '…' : `₹${bal.toFixed(2)}`}
              </div>
            </div>
            <div>
              <div className="text-[0.75rem] text-dim mb-[0.2rem]">This Month&apos;s Spend</div>
              <div id="wlt-monthly" className="text-[1.5rem] font-bold">
                {walletQ.loading && !walletQ.data ? '…' : `₹${monthly.toFixed(2)}`}
              </div>
            </div>
            <div>
              <div className="text-[0.75rem] text-dim mb-[0.2rem]">Status</div>
              <div id="wlt-status" className={`text-[1.1rem] font-semibold ${active ? 'text-wa' : 'text-red'}`}>
                {walletQ.loading && !walletQ.data ? '…' : active ? 'Active' : 'Suspended'}
              </div>
            </div>
          </div>
        )}

        {!walletQ.error && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-[0.6rem] p-3 bg-ink2 border border-rim rounded-lg mb-4">
            <div>
              <div className="text-[0.7rem] text-dim mb-[0.15rem]">Earned this month</div>
              <div className="text-[1.05rem] font-bold text-wa">
                ₹{monthEarnings.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-[0.7rem] text-dim mb-[0.15rem]">Spent on messages</div>
              <div className="text-[1.05rem] font-bold">
                ₹{monthMessages.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-[0.7rem] text-dim mb-[0.15rem]">Campaign charges</div>
              <div className="text-[1.05rem] font-bold">
                ₹{monthCampaigns.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-[0.7rem] text-dim mb-[0.15rem]">Referral commissions</div>
              <div className="text-[1.05rem] font-bold">
                ₹{monthReferrals.toFixed(2)}
              </div>
            </div>
            <div className="col-span-full border-t border-rim pt-[0.55rem]">
              <div className="text-[0.7rem] text-dim mb-[0.15rem]">Net balance</div>
              <div className={`text-[1.4rem] font-extrabold ${balanceColorClass(bal, threshold)}`}>
                ₹{bal.toFixed(2)}
              </div>
            </div>
          </div>
        )}

        {showTopup && (
          <div
            id="wlt-topup-form"
            className="p-[0.8rem] bg-ink2 border border-bdr rounded-lg mb-4"
          >
            <div className="text-[0.82rem] font-semibold mb-2">Quick Top-Up</div>
            <div className="flex gap-[0.4rem] flex-wrap mb-2">
              {TOPUP_PRESETS.map((amt) => {
                const selected = customAmt === String(amt);
                return (
                  <button
                    key={amt}
                    type="button"
                    className={selected ? 'btn-p btn-sm' : 'btn-g btn-sm'}
                    aria-pressed={selected}
                    disabled={busy}
                    onClick={() => setCustomAmt(String(amt))}
                  >
                    ₹{amt}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-[0.4rem] items-center">
              <input
                id="wlt-custom-amt"
                type="number"
                placeholder="Custom amount"
                min={100}
                max={10000}
                value={customAmt}
                onChange={(e) => setCustomAmt(e.target.value)}
                className="w-[120px] py-[0.35rem] px-2 border border-rim rounded-md text-[0.82rem]"
              />
              <button
                type="button"
                className="btn-p btn-sm"
                disabled={busy}
                onClick={() => doTopup(parseInt(customAmt, 10))}
              >
                {busy ? '…' : 'Pay'}
              </button>
              <button
                type="button"
                className="btn-g btn-sm"
                disabled={busy}
                onClick={() => { setShowTopup(false); setCustomAmt(''); }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="text-[0.82rem] font-semibold mb-[0.4rem]">Recent Transactions</div>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Description</th>
                <th>Amount</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {txnsQ.error ? (
                <tr><td colSpan={5} className="p-4">
                  <SectionError message={txnsQ.error} onRetry={txnsQ.refetch} />
                </td></tr>
              ) : txnsQ.loading && !txnsQ.data ? (
                <tr><td colSpan={5} className="p-4 text-center text-dim">Loading…</td></tr>
              ) : !txns.length ? (
                <tr><td colSpan={5} className="p-4 text-center text-dim">
                  No transactions yet
                </td></tr>
              ) : (
                txns.map((t, idx) => {
                  const amt = Number(t.amount_rs) || 0;
                  return (
                    <tr key={t.id || t._id || idx} className="border-b border-rim">
                      <td className="py-[0.45rem] px-[0.7rem] text-[0.78rem]">
                        {formatTxnDate(t.created_at)}
                      </td>
                      <td className="py-[0.45rem] px-[0.7rem] text-[0.8rem]">
                        {TYPE_ICO[t.type || ''] || ''} {TYPE_LABEL[t.type || ''] || t.type}
                      </td>
                      <td className="py-[0.45rem] px-[0.7rem] text-[0.78rem] text-dim max-w-[200px] truncate">
                        {t.description || '—'}
                      </td>
                      <td
                        className={`py-[0.45rem] px-[0.7rem] font-semibold ${amt >= 0 ? 'text-wa' : 'text-red'}`}
                      >
                        {amt >= 0 ? '+' : ''}₹{Math.abs(amt).toFixed(2)}
                      </td>
                      <td className="py-[0.45rem] px-[0.7rem] text-[0.78rem]">
                        ₹{parseFloat(String(t.balance_after_rs ?? '0')).toFixed(2)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
