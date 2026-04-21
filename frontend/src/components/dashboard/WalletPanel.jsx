import { useEffect, useState, useCallback, useRef } from 'react';
import { getWallet, getWalletTransactions } from '../../api/restaurant.js';

// Slide-out drawer on the right with the unified wallet balance and
// a single chronological list of all transaction types. Top-up
// button is disabled until campaigns_enabled is true for the
// restaurant — ordering and message charges don't require a balance,
// so until campaigns ship there's no reason to top up.

const TYPE_META = {
  order_payout:          { label: 'Order Payout',       tone: 'credit' },
  topup:                 { label: 'Top Up',             tone: 'credit' },
  refund:                { label: 'Refund',             tone: 'credit' },
  deduction:             { label: 'Message Charge',     tone: 'debit'  },
  settlement_deduction:  { label: 'Settlement Deduct',  tone: 'debit'  },
  meta_marketing_charge: { label: 'Campaign Charge',    tone: 'debit'  },
  referral_commission:   { label: 'Referral Commission', tone: 'debit' },
};

const TONE_STYLES = {
  credit: { bg: '#ecfdf5', fg: '#065f46' },
  debit:  { bg: '#fef2f2', fg: '#991b1b' },
};

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' · '
    + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function rupees(n) {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
}

export default function WalletPanel({ onClose }) {
  const [wallet, setWallet] = useState(null);
  const [items, setItems] = useState([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const panelRef = useRef(null);

  const PAGE_SIZE = 20;

  const loadPage = useCallback(async (off) => {
    const data = await getWalletTransactions({ limit: PAGE_SIZE, offset: off });
    // The existing endpoint returns an array (not paginated). We infer
    // has_more from the page being full.
    const arr = Array.isArray(data) ? data : [];
    return { items: arr, hasMore: arr.length === PAGE_SIZE };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [w, page] = await Promise.all([getWallet(), loadPage(0)]);
        if (cancelled) return;
        setWallet(w);
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
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose();
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

  const campaignsEnabled = !!wallet?.campaigns_enabled;
  const bal = Number(wallet?.balance_rs || 0);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <aside
        ref={panelRef}
        style={{
          width: 'min(420px, 100vw)', height: '100%',
          background: '#fff', boxShadow: '-2px 0 16px rgba(0,0,0,0.12)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <header style={{
          padding: '1.1rem 1.25rem',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: '1rem', fontWeight: 700 }}>Wallet</div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            style={{
              background: 'transparent', border: 'none', fontSize: '1.4rem',
              lineHeight: 1, cursor: 'pointer', color: '#6b7280',
            }}
          >
            ×
          </button>
        </header>

        <section style={{
          padding: '1.25rem',
          background: 'linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%)',
          borderBottom: '1px solid #e5e7eb',
        }}>
          <div style={{ fontSize: '.75rem', color: '#047857', fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase' }}>
            Balance
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#064e3b', marginTop: '.25rem' }}>
            {loading ? '…' : rupees(bal)}
          </div>
          <div style={{ display: 'flex', gap: '1.25rem', marginTop: '.75rem', fontSize: '.78rem', color: '#065f46', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 600 }}>Earned this month</div>
              <div>{rupees(wallet?.current_month_earnings_rs)}</div>
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>Spent this month</div>
              <div>{rupees(wallet?.current_month_charges_rs)}</div>
            </div>
          </div>
          <button
            type="button"
            disabled={!campaignsEnabled}
            title={campaignsEnabled ? 'Add money' : 'Available when campaigns are active'}
            style={{
              marginTop: '1rem',
              padding: '.55rem 1rem', borderRadius: 8,
              border: 'none', cursor: campaignsEnabled ? 'pointer' : 'not-allowed',
              background: campaignsEnabled ? '#059669' : '#d1d5db',
              color: campaignsEnabled ? '#fff' : '#6b7280',
              fontSize: '.82rem', fontWeight: 700,
            }}
          >
            + Add Money
          </button>
        </section>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{
            padding: '.85rem 1.25rem .5rem',
            fontSize: '.72rem', fontWeight: 700, color: '#6b7280',
            letterSpacing: '.05em', textTransform: 'uppercase',
          }}>
            Transactions
          </div>

          {loading && (
            <div style={{ padding: '1.25rem', color: '#6b7280', fontSize: '.85rem' }}>Loading…</div>
          )}

          {!loading && items.length === 0 && (
            <div style={{ padding: '1.25rem', color: '#6b7280', fontSize: '.85rem' }}>
              No transactions yet. Order payouts and charges will appear here.
            </div>
          )}

          {!loading && items.map((t) => {
            const meta = TYPE_META[t.type] || { label: t.type, tone: 'debit' };
            const badge = TONE_STYLES[meta.tone];
            const isCredit = meta.tone === 'credit';
            const amt = Number(t.amount_rs) || 0;
            const signed = (isCredit ? '+' : '-') + rupees(Math.abs(amt));
            return (
              <div
                key={t._id || `${t.created_at}-${t.reference_id}`}
                style={{
                  padding: '.85rem 1.25rem',
                  borderBottom: '1px solid #f3f4f6',
                  display: 'flex', justifyContent: 'space-between', gap: '.75rem',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <span style={{
                    display: 'inline-block',
                    background: badge.bg, color: badge.fg,
                    fontSize: '.68rem', fontWeight: 700,
                    padding: '.15rem .5rem', borderRadius: 999,
                    marginBottom: '.25rem',
                  }}>
                    {meta.label}
                  </span>
                  <div style={{
                    fontSize: '.82rem', color: '#111827',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {t.description || '—'}
                  </div>
                  <div style={{ fontSize: '.72rem', color: '#9ca3af', marginTop: '.15rem' }}>
                    {formatDate(t.created_at)}
                  </div>
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{
                    fontSize: '.9rem', fontWeight: 700,
                    color: isCredit ? '#065f46' : '#991b1b',
                  }}>
                    {signed}
                  </div>
                  <div style={{ fontSize: '.7rem', color: '#9ca3af', marginTop: '.15rem' }}>
                    Bal {rupees(t.balance_after_rs)}
                  </div>
                </div>
              </div>
            );
          })}

          {!loading && hasMore && (
            <div style={{ padding: '.85rem 1.25rem', textAlign: 'center' }}>
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                style={{
                  padding: '.5rem 1rem', borderRadius: 8,
                  border: '1px solid #d1d5db', background: '#fff',
                  fontSize: '.8rem', fontWeight: 600, color: '#374151',
                  cursor: loadingMore ? 'wait' : 'pointer',
                }}
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
