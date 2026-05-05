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

function balanceColor(bal: number, threshold: number): string {
  if (bal > threshold) return 'var(--wa)';
  if (bal > 0) return '#d97706';
  return 'var(--red,#dc2626)';
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
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch" style={{ justifyContent: 'space-between' }}>
        <h3>Wallet</h3>
        <button type="button" className="btn-p btn-sm" onClick={() => setShowTopup(true)}>
          Top Up
        </button>
      </div>
      <div className="cb">
        {walletQ.error ? (
          <SectionError message={walletQ.error} onRetry={walletQ.refetch} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginBottom: '.2rem' }}>Current Balance</div>
              <div id="wlt-balance" style={{ fontSize: '1.5rem', fontWeight: 700, color: balanceColor(bal, threshold) }}>
                {walletQ.loading && !walletQ.data ? '…' : `₹${bal.toFixed(2)}`}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginBottom: '.2rem' }}>This Month&apos;s Spend</div>
              <div id="wlt-monthly" style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                {walletQ.loading && !walletQ.data ? '…' : `₹${monthly.toFixed(2)}`}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '.75rem', color: 'var(--dim)', marginBottom: '.2rem' }}>Status</div>
              <div id="wlt-status" style={{ fontSize: '1.1rem', fontWeight: 600, color: active ? 'var(--wa)' : 'var(--red,#dc2626)' }}>
                {walletQ.loading && !walletQ.data ? '…' : active ? 'Active' : 'Suspended'}
              </div>
            </div>
          </div>
        )}

        {!walletQ.error && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '.6rem',
              padding: '.75rem',
              background: 'var(--ink2, #f9fafb)',
              border: '1px solid var(--rim, #e5e7eb)',
              borderRadius: 8,
              marginBottom: '1rem',
            }}
          >
            <div>
              <div style={{ fontSize: '.7rem', color: 'var(--dim)', marginBottom: '.15rem' }}>Earned this month</div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--wa, #059669)' }}>
                ₹{monthEarnings.toFixed(2)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '.7rem', color: 'var(--dim)', marginBottom: '.15rem' }}>Spent on messages</div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>
                ₹{monthMessages.toFixed(2)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '.7rem', color: 'var(--dim)', marginBottom: '.15rem' }}>Campaign charges</div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>
                ₹{monthCampaigns.toFixed(2)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '.7rem', color: 'var(--dim)', marginBottom: '.15rem' }}>Referral commissions</div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>
                ₹{monthReferrals.toFixed(2)}
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--rim, #e5e7eb)', paddingTop: '.55rem' }}>
              <div style={{ fontSize: '.7rem', color: 'var(--dim)', marginBottom: '.15rem' }}>Net balance</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: balanceColor(bal, threshold) }}>
                ₹{bal.toFixed(2)}
              </div>
            </div>
          </div>
        )}

        {showTopup && (
          <div
            id="wlt-topup-form"
            style={{
              padding: '.8rem',
              background: 'var(--ink2)',
              border: '1px solid var(--bdr,var(--rim))',
              borderRadius: 8,
              marginBottom: '1rem',
            }}
          >
            <div style={{ fontSize: '.82rem', fontWeight: 600, marginBottom: '.5rem' }}>Quick Top-Up</div>
            <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', marginBottom: '.5rem' }}>
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
            <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
              <input
                id="wlt-custom-amt"
                type="number"
                placeholder="Custom amount"
                min={100}
                max={10000}
                value={customAmt}
                onChange={(e) => setCustomAmt(e.target.value)}
                style={{ width: 120, padding: '.35rem .5rem', border: '1px solid var(--rim)', borderRadius: 6, fontSize: '.82rem' }}
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

        <div style={{ fontSize: '.82rem', fontWeight: 600, marginBottom: '.4rem' }}>Recent Transactions</div>
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
                <tr><td colSpan={5} style={{ padding: '1rem' }}>
                  <SectionError message={txnsQ.error} onRetry={txnsQ.refetch} />
                </td></tr>
              ) : txnsQ.loading && !txnsQ.data ? (
                <tr><td colSpan={5} style={{ padding: '1rem', textAlign: 'center', color: 'var(--dim)' }}>Loading…</td></tr>
              ) : !txns.length ? (
                <tr><td colSpan={5} style={{ padding: '1rem', textAlign: 'center', color: 'var(--dim)' }}>
                  No transactions yet
                </td></tr>
              ) : (
                txns.map((t, idx) => {
                  const amt = Number(t.amount_rs) || 0;
                  return (
                    <tr key={t.id || t._id || idx} style={{ borderBottom: '1px solid var(--rim)' }}>
                      <td style={{ padding: '.45rem .7rem', fontSize: '.78rem' }}>
                        {formatTxnDate(t.created_at)}
                      </td>
                      <td style={{ padding: '.45rem .7rem', fontSize: '.8rem' }}>
                        {TYPE_ICO[t.type || ''] || ''} {TYPE_LABEL[t.type || ''] || t.type}
                      </td>
                      <td style={{
                        padding: '.45rem .7rem',
                        fontSize: '.78rem',
                        color: 'var(--dim)',
                        maxWidth: 200,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      >
                        {t.description || '—'}
                      </td>
                      <td style={{
                        padding: '.45rem .7rem',
                        fontWeight: 600,
                        color: amt >= 0 ? 'var(--wa)' : 'var(--red,#dc2626)',
                      }}
                      >
                        {amt >= 0 ? '+' : ''}₹{Math.abs(amt).toFixed(2)}
                      </td>
                      <td style={{ padding: '.45rem .7rem', fontSize: '.78rem' }}>
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
