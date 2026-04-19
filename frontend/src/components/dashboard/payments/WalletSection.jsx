import { useCallback, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch.js';
import SectionError from '../analytics/SectionError.jsx';
import { useToast } from '../../Toast.jsx';
import {
  getWallet,
  getWalletTransactions,
  topUpWallet,
} from '../../../api/restaurant.js';

// Mirrors loadWallet() + showWalletTopup() + doWalletTopup() in legacy
// payments.js:409-455. Top-up uses Razorpay Checkout.js (window.Razorpay)
// — we inject the script on demand since the React shell does not load it
// at boot. Amount range and preset chips mirror the legacy form exactly
// (min ₹100, max ₹10,000; presets 100/200/500/1000).
const RAZORPAY_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
const TOPUP_PRESETS = [100, 200, 500, 1000];
const TYPE_ICO = {
  topup: '✅',
  deduction: '📤',
  settlement_deduction: '📋',
  refund: '↩️',
};

function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('No window'));
    if (window.Razorpay) return resolve(window.Razorpay);
    const existing = document.querySelector(`script[src="${RAZORPAY_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.Razorpay));
      existing.addEventListener('error', () => reject(new Error('Razorpay script failed to load')));
      return undefined;
    }
    const s = document.createElement('script');
    s.src = RAZORPAY_SRC;
    s.async = true;
    s.onload = () => resolve(window.Razorpay);
    s.onerror = () => reject(new Error('Razorpay script failed to load'));
    document.head.appendChild(s);
    return undefined;
  });
}

function formatTxnDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function balanceColor(bal, threshold) {
  if (bal > threshold) return 'var(--wa)';
  if (bal > 0) return '#d97706';
  return 'var(--red,#dc2626)';
}

export default function WalletSection() {
  const { showToast } = useToast();
  const [showTopup, setShowTopup] = useState(false);
  const [customAmt, setCustomAmt] = useState('');
  const [busy, setBusy] = useState(false);

  const walletQ = useAnalyticsFetch(
    useCallback(() => getWallet(), []),
    [],
  );
  const txnsQ = useAnalyticsFetch(
    useCallback(() => getWalletTransactions({ limit: 20 }), []),
    [],
  );

  const w = walletQ.data || {};
  const bal = parseFloat(w.balance_rs) || 0;
  const threshold = Number(w.low_balance_threshold_rs) || 100;
  const monthly = parseFloat(w.monthly_spend_rs) || 0;
  const active = w.status === 'active';

  const txns = Array.isArray(txnsQ.data) ? txnsQ.data : [];

  const doTopup = async (amt) => {
    if (busy) return;
    if (!amt || amt < 100 || amt > 10000) {
      showToast('Amount must be ₹100 – ₹10,000', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await topUpWallet({ amount_rs: amt });
      if (!r?.razorpay_order_id) {
        showToast('Failed to create payment', 'error');
        return;
      }
      const Razorpay = await loadRazorpayScript();
      const rzp = new Razorpay({
        key: r.key_id,
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
      });
      rzp.open();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Top-up failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch" style={{ justifyContent: 'space-between' }}>
        <h3>Messaging Wallet</h3>
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
              {TOPUP_PRESETS.map((amt, idx) => (
                <button
                  key={amt}
                  type="button"
                  className={idx === TOPUP_PRESETS.length - 1 ? 'btn-p btn-sm' : 'btn-g btn-sm'}
                  disabled={busy}
                  onClick={() => doTopup(amt)}
                >
                  ₹{amt}
                </button>
              ))}
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
                txns.map((t, idx) => (
                  <tr key={t.id || t._id || idx} style={{ borderBottom: '1px solid var(--rim)' }}>
                    <td style={{ padding: '.45rem .7rem', fontSize: '.78rem' }}>
                      {formatTxnDate(t.created_at)}
                    </td>
                    <td style={{ padding: '.45rem .7rem', fontSize: '.8rem' }}>
                      {TYPE_ICO[t.type] || ''} {t.type}
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
                      color: t.amount_rs >= 0 ? 'var(--wa)' : 'var(--red,#dc2626)',
                    }}
                    >
                      {t.amount_rs >= 0 ? '+' : ''}₹{Math.abs(t.amount_rs).toFixed(2)}
                    </td>
                    <td style={{ padding: '.45rem .7rem', fontSize: '.78rem' }}>
                      ₹{parseFloat(t.balance_after_rs || 0).toFixed(2)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
