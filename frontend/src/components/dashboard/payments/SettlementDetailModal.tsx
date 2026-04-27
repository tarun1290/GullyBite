'use client';

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useToast } from '../../Toast';
import {
  getSettlementById,
  getSettlementMetaBreakdown,
  downloadSettlement,
} from '../../../api/restaurant';

const STATUS_CLS: Record<string, string> = { PAID: 'bg', PENDING: 'ba', PROCESSING: 'bb', FAILED: 'br' };

// Field names mirror the actual settlement document written by
// jobs/settlement.js (insertOne at line 142). The backend route
// GET /api/restaurant/financials/settlements/:id returns
// { settlement, orders } with the raw document inline as `settlement`.
// Names use _rs suffixes everywhere except for status/timestamp fields.
interface SettlementDoc {
  // Period + status
  period_start?: string;
  period_end?: string;
  payout_status?: string;
  payout_utr?: string | null;
  payout_at?: string | null;
  payout_completed_at?: string | null;
  // Revenue breakdown
  food_revenue_rs?: number;
  food_gst_collected_rs?: number;
  packaging_collected_rs?: number;
  packaging_gst_rs?: number;
  delivery_fee_collected_rs?: number;
  // Deductions
  platform_fee_rs?: number;
  platform_fee_gst_rs?: number;
  delivery_fee_restaurant_share_rs?: number;
  delivery_fee_restaurant_gst_rs?: number;
  discount_total_rs?: number;
  refund_total_rs?: number;
  tds_amount_rs?: number;
  tds_applicable?: boolean;
  referral_fee_rs?: number;
  referral_fee_gst_rs?: number;
  // Cancellation penalties (REJECTED_BY_RESTAURANT / RESTAURANT_TIMEOUT
  // Razorpay-fee debits accumulated against the restaurant). Backed by
  // services/orderCancellationService — will be ₹0 until jobs/settlement.js
  // drains restaurants.pending_cancellation_fault_fees_paise into the
  // settlement row. Known gap, not a bug.
  cancellation_fault_fees?: number;
  // Totals
  gross_revenue_rs?: number;
  net_payout_rs?: number;
}

interface SettlementOrder {
  _id?: string;
  order_number?: string;
  delivered_at?: string;
  created_at?: string;
  total_rs?: number;
  status?: string;
}

// Wrapper returned by the backend route.
interface SettlementDetail {
  settlement?: SettlementDoc;
  orders?: SettlementOrder[];
}

interface MetaItem {
  id?: string;
  customer_name?: string;
  phone?: string;
  message_type?: string;
  cost?: number | string;
  sent_at?: string;
}

interface MetaData {
  meta_message_count?: number;
  meta_cost_total_paise?: number;
  items?: MetaItem[];
}

function formatINR(n: number | undefined | null): string {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

interface BdLineProps { label: string; value: number | undefined; sign: '+' | '-' | '' }

function BdLine({ label, value, sign }: BdLineProps) {
  const color = sign === '-' ? 'var(--red,#dc2626)' : sign === '+' ? 'var(--wa)' : 'var(--tx)';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--dim)' }}>{label}</span>
      <span style={{ color }}>{sign || ''} {formatINR(Math.abs(value || 0))}</span>
    </div>
  );
}

interface BdTotalProps { label: string; value: number | undefined; color?: string }

function BdTotal({ label, value, color }: BdTotalProps) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
      <span style={{ color: color || 'var(--tx)' }}>{label}</span>
      <span style={{ color: color || 'var(--tx)' }}>{formatINR(value || 0)}</span>
    </div>
  );
}

const DASH: ReactNode = <div style={{ borderTop: '1px dashed var(--rim)', margin: '.3rem 0' }} />;

interface MetaBreakdownProps { data: MetaData | null }

function MetaBreakdown({ data }: MetaBreakdownProps) {
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

interface SettlementDetailModalProps {
  settlementId: string;
  onClose: () => void;
}

export default function SettlementDetailModal({ settlementId, onClose }: SettlementDetailModalProps) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<SettlementDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<MetaData | null>(null);
  const [downloading, setDownloading] = useState<boolean>(false);

  useEffect(() => {
    if (!settlementId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setMeta(null);
    getSettlementById(settlementId)
      .then((d) => { if (!cancelled) setDetail(d as SettlementDetail | null); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e as { response?: { data?: { error?: string } }; message?: string };
        setError(err?.response?.data?.error || err?.message || 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    getSettlementMetaBreakdown(settlementId)
      .then((m) => { if (!cancelled) setMeta(m as MetaData | null); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [settlementId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const resp = await downloadSettlement(settlementId);
      const headers = resp.headers as Record<string, string | undefined>;
      const cd = headers?.['content-disposition'] || '';
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
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Download failed', 'error');
    } finally {
      setDownloading(false);
    }
  };

  // Backend returns { settlement, orders } — pull the raw settlement doc
  // out of the wrapper. (Old code was casting the entire wrapper as a
  // breakdown, which silently produced all-zero rows.)
  const settlementDoc: SettlementDoc = detail?.settlement || {};
  const statusKey = settlementDoc.payout_status?.toUpperCase?.() || '';
  const statusCls = STATUS_CLS[statusKey] || 'bd';
  const paidAtRaw = settlementDoc.payout_completed_at || settlementDoc.payout_at;
  const paidAtDisplay = paidAtRaw
    ? new Date(paidAtRaw).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '';
  const periodDisplay = (raw?: string | null): string => {
    if (!raw) return '';
    const d = new Date(raw);
    return Number.isNaN(d.getTime())
      ? String(raw)
      : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  return (
    <div
      onClick={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onClose?.(); }}
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
                  <div style={{ fontWeight: 700 }}>{periodDisplay(settlementDoc.period_start)} → {periodDisplay(settlementDoc.period_end)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className={`badge ${statusCls}`} style={{ fontSize: '.75rem' }}>{settlementDoc.payout_status || 'N/A'}</span>
                  {settlementDoc.payout_utr && (
                    <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.2rem' }}>
                      UTR: <span style={{ fontFamily: 'monospace' }}>{settlementDoc.payout_utr}</span>
                    </div>
                  )}
                  {paidAtDisplay && (
                    <div style={{ fontSize: '.72rem', color: 'var(--dim)' }}>Paid: {paidAtDisplay}</div>
                  )}
                </div>
              </div>

              <div style={{ fontFamily: "'SF Mono',monospace", fontSize: '.78rem', lineHeight: 1.9, background: 'var(--ink4)', borderRadius: 8, padding: '1rem 1.2rem', marginBottom: '1rem' }}>
                <BdLine label="Food Revenue" value={settlementDoc.food_revenue_rs} sign="" />
                <BdLine label="Food GST" value={settlementDoc.food_gst_collected_rs} sign="+" />
                <BdLine label="Packaging" value={settlementDoc.packaging_collected_rs} sign="+" />
                <BdLine label="Packaging GST" value={settlementDoc.packaging_gst_rs} sign="+" />
                <BdLine label="Delivery Fee" value={settlementDoc.delivery_fee_collected_rs} sign="+" />
                {DASH}
                <BdTotal label="GROSS" value={settlementDoc.gross_revenue_rs} color="var(--acc)" />
                {DASH}
                <BdLine label="Platform Fee" value={settlementDoc.platform_fee_rs} sign="-" />
                <BdLine label="Platform Fee GST" value={settlementDoc.platform_fee_gst_rs} sign="-" />
                <BdLine label="Delivery Cost (Absorbed Share)" value={settlementDoc.delivery_fee_restaurant_share_rs} sign="-" />
                <BdLine label="Delivery GST" value={settlementDoc.delivery_fee_restaurant_gst_rs} sign="-" />
                <BdLine label="Discounts" value={settlementDoc.discount_total_rs} sign="-" />
                <BdLine label="Refunds" value={settlementDoc.refund_total_rs} sign="-" />
                <BdLine label="TDS" value={settlementDoc.tds_amount_rs} sign="-" />
                <BdLine label="Referral Fee" value={settlementDoc.referral_fee_rs} sign="-" />
                <BdLine label="Referral GST" value={settlementDoc.referral_fee_gst_rs} sign="-" />
                <BdLine label="Cancellation Penalty Charges" value={settlementDoc.cancellation_fault_fees || 0} sign="-" />
                {DASH}
                <BdTotal label="NET PAYOUT" value={settlementDoc.net_payout_rs} color="var(--wa)" />
              </div>

              <MetaBreakdown data={meta} />

              {detail.orders?.length ? (
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
                          <tr key={o._id || o.order_number || idx}>
                            <td style={{ fontFamily: 'monospace', fontSize: '.75rem' }}>
                              {o.order_number || o._id}
                            </td>
                            <td style={{ fontSize: '.78rem' }}>{periodDisplay(o.delivered_at || o.created_at)}</td>
                            <td>{formatINR(o.total_rs)}</td>
                            <td><span className="badge bg">{o.status || 'Delivered'}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
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
