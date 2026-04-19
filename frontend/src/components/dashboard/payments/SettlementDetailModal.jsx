import { useEffect, useState } from 'react';
import { useToast } from '../../Toast.jsx';
import {
  getSettlementById,
  getSettlementMetaBreakdown,
  downloadSettlement,
} from '../../../api/restaurant.js';

// Mirrors openSettlementDetail() + loadSettleMetaBreakdown() +
// downloadFinSettlement() in legacy payments.js:210-321. Meta breakdown is
// silent-fail: if the endpoint 404s or returns 0 messages, the disclosure
// stays hidden. Download uses a blob round-trip so the auth header is
// forwarded and the filename comes off content-disposition.
const STATUS_CLS = { PAID: 'bg', PENDING: 'ba', PROCESSING: 'bb', FAILED: 'br' };

function formatINR(n) {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

function BdLine({ label, value, sign }) {
  const color = sign === '-' ? 'var(--red,#dc2626)' : sign === '+' ? 'var(--wa)' : 'var(--tx)';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--dim)' }}>{label}</span>
      <span style={{ color }}>{sign || ''} {formatINR(Math.abs(value || 0))}</span>
    </div>
  );
}

function BdTotal({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
      <span style={{ color: color || 'var(--tx)' }}>{label}</span>
      <span style={{ color: color || 'var(--tx)' }}>{formatINR(value || 0)}</span>
    </div>
  );
}

const DASH = <div style={{ borderTop: '1px dashed var(--rim)', margin: '.3rem 0' }} />;

function MetaBreakdown({ data }) {
  if (!data || !data.meta_message_count) return null;
  const totalRs = ((data.meta_cost_total_paise || 0) / 100).toFixed(2);
  const items = data.items || [];
  return (
    <div style={{ marginBottom: '1rem' }}>
      <details style={{ background: 'var(--ink4)', borderRadius: 8, padding: '.8rem 1rem' }}>
        <summary style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
          <span style={{ fontWeight: 700, color: 'var(--tx)' }}>Meta Messaging Charges</span>
          <span style={{ fontSize: '.8rem', color: 'var(--dim)' }}>
            {data.meta_message_count} message{data.meta_message_count === 1 ? '' : 's'}
            {' · '}
            <span style={{ color: 'var(--red,#dc2626)' }}>− ₹{totalRs}</span>
          </span>
        </summary>
        <div style={{ maxHeight: 220, overflow: 'auto', marginTop: '.6rem', border: '1px solid var(--rim)', borderRadius: 6 }}>
          <table style={{ width: '100%', fontSize: '.78rem' }}>
            <thead>
              <tr>
                <th style={{ padding: '.4rem .6rem', textAlign: 'left' }}>Customer</th>
                <th style={{ padding: '.4rem .6rem', textAlign: 'left' }}>Phone</th>
                <th style={{ padding: '.4rem .6rem', textAlign: 'left' }}>Type</th>
                <th style={{ padding: '.4rem .6rem', textAlign: 'left' }}>Cost</th>
                <th style={{ padding: '.4rem .6rem', textAlign: 'left' }}>Time</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m, idx) => (
                <tr key={m.id || idx}>
                  <td style={{ padding: '.4rem .6rem' }}>{m.customer_name || '—'}</td>
                  <td style={{ padding: '.4rem .6rem', fontFamily: 'monospace', color: 'var(--dim)' }}>{m.phone || '—'}</td>
                  <td style={{ padding: '.4rem .6rem' }}>{m.message_type || '—'}</td>
                  <td style={{ padding: '.4rem .6rem' }}>₹{Number(m.cost || 0).toFixed(2)}</td>
                  <td style={{ padding: '.4rem .6rem', color: 'var(--dim)', fontSize: '.75rem' }}>
                    {m.sent_at ? new Date(m.sent_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export default function SettlementDetailModal({ settlementId, onClose }) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!settlementId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setMeta(null);
    getSettlementById(settlementId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.error || e.message || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    // Meta is silent-fail — legacy ignores errors and 0-count responses.
    getSettlementMetaBreakdown(settlementId)
      .then((m) => { if (!cancelled) setMeta(m); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [settlementId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const resp = await downloadSettlement(settlementId);
      const cd = resp.headers?.['content-disposition'] || '';
      const match = cd.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || `settlement_${settlementId}.xlsx`;
      const blob = resp.data instanceof Blob ? resp.data : new Blob([resp.data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Download failed', 'error');
    } finally {
      setDownloading(false);
    }
  };

  const breakdown = detail?.breakdown || detail || {};
  const statusCls = STATUS_CLS[detail?.payout_status?.toUpperCase?.()] || 'bd';

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,.55)',
        backdropFilter: 'blur(4px)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
      }}
    >
      <div style={{ background: 'var(--ink2,#fff)', borderRadius: 12, maxWidth: 720, width: '100%', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '1rem 1.3rem', borderBottom: '1px solid var(--rim)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: '.95rem', color: 'var(--tx)' }}>Settlement Detail</span>
          <button type="button" className="btn-g btn-sm" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '1.3rem', maxHeight: '75vh', overflowY: 'auto', fontSize: '.84rem' }}>
          {error ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--red,#dc2626)' }}>
              Error: {error}
            </div>
          ) : loading || !detail ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--dim)' }}>Loading…</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem', flexWrap: 'wrap', gap: '.6rem' }}>
                <div>
                  <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginBottom: '.2rem' }}>Period</div>
                  <div style={{ fontWeight: 700 }}>{detail.period_start || ''} → {detail.period_end || ''}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className={`badge ${statusCls}`} style={{ fontSize: '.75rem' }}>{detail.payout_status || 'N/A'}</span>
                  {detail.utr && (
                    <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.2rem' }}>
                      UTR: <span style={{ fontFamily: 'monospace' }}>{detail.utr}</span>
                    </div>
                  )}
                  {detail.payout_date && (
                    <div style={{ fontSize: '.72rem', color: 'var(--dim)' }}>Paid: {detail.payout_date}</div>
                  )}
                </div>
              </div>

              <div style={{ fontFamily: "'SF Mono',monospace", fontSize: '.78rem', lineHeight: 1.9, background: 'var(--ink4)', borderRadius: 8, padding: '1rem 1.2rem', marginBottom: '1rem' }}>
                <BdLine label="Food Revenue" value={breakdown.food_revenue} sign="" />
                <BdLine label="Food GST" value={breakdown.food_gst} sign="+" />
                <BdLine label="Packaging" value={breakdown.packaging_revenue} sign="+" />
                <BdLine label="Packaging GST" value={breakdown.packaging_gst} sign="+" />
                <BdLine label="Delivery Fee" value={breakdown.delivery_fee_customer} sign="+" />
                {DASH}
                <BdTotal label="GROSS" value={breakdown.gross_collections} color="var(--acc)" />
                {DASH}
                <BdLine label="Platform Fee" value={breakdown.platform_fee} sign="-" />
                <BdLine label="Platform Fee GST" value={breakdown.platform_fee_gst} sign="-" />
                <BdLine label="Delivery Cost" value={breakdown.delivery_cost} sign="-" />
                <BdLine label="Delivery GST" value={breakdown.delivery_gst} sign="-" />
                <BdLine label="Discounts" value={breakdown.discounts} sign="-" />
                <BdLine label="Refunds" value={breakdown.refunds} sign="-" />
                <BdLine label="TDS" value={breakdown.tds} sign="-" />
                <BdLine label="Referral Fee" value={breakdown.referral_fee} sign="-" />
                <BdLine label="Referral GST" value={breakdown.referral_fee_gst} sign="-" />
                {DASH}
                <BdTotal label="NET PAYOUT" value={breakdown.net_payout} color="var(--wa)" />
              </div>

              <MetaBreakdown data={meta} />

              {detail.orders?.length > 0 && (
                <>
                  <div style={{ fontSize: '.72rem', fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--mute,var(--dim))', marginBottom: '.4rem' }}>
                    Orders in this Settlement ({detail.orders.length})
                  </div>
                  <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--rim)', borderRadius: 8 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Order #</th>
                          <th>Date</th>
                          <th>Amount</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.orders.map((o, idx) => (
                          <tr key={o.id || o.order_number || idx}>
                            <td style={{ fontFamily: 'monospace', fontSize: '.75rem' }}>
                              {o.order_number || o.id}
                            </td>
                            <td style={{ fontSize: '.78rem' }}>{o.date || ''}</td>
                            <td>{formatINR(o.amount)}</td>
                            <td><span className="badge bg">{o.status || 'Delivered'}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <div style={{ padding: '.8rem 1.3rem', borderTop: '1px solid var(--rim)', display: 'flex', justifyContent: 'flex-end', gap: '.5rem' }}>
          {detail && (
            <button type="button" className="btn-p" disabled={downloading} onClick={handleDownload}>
              {downloading ? 'Preparing…' : '📥 Download Excel'}
            </button>
          )}
          <button type="button" className="btn-g btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
