'use client';

import { useCallback, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import { getTaxSummary } from '../../../api/restaurant';

const TABS: ReadonlyArray<readonly [string, string]> = [
  ['gst', 'GST Summary'],
  ['tds', 'TDS Summary'],
  ['info', 'Tax Info'],
];

interface GstRow {
  month?: string;
  food_gst?: number | string;
  packaging_gst?: number | string;
  delivery_gst?: number | string;
  platform_fee_gst?: number | string;
  total_gst?: number | string;
}

interface TdsRow {
  settlement_id?: string;
  period?: string;
  gross?: number | string;
  tds_rate?: string;
  tds_amount?: number | string;
  certificate_url?: string;
}

interface TaxSummary {
  gst_monthly?: GstRow[];
  tds_records?: TdsRow[];
  gstin?: string;
  gstin_status?: string;
  pan?: string;
  pan_status?: string;
}

function formatINR(n: number | string | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return `₹${v.toLocaleString('en-IN')}`;
}

interface GstPanelProps { rows: GstRow[]; loading: boolean }

function GstPanel({ rows, loading }: GstPanelProps) {
  return (
    <div className="tbl">
      <table>
        <thead>
          <tr>
            <th>Month</th>
            <th>Food GST</th>
            <th>Pkg GST</th>
            <th>Delivery GST</th>
            <th>Platform Fee GST</th>
            <th>Total GST</th>
          </tr>
        </thead>
        <tbody id="fin-gst-body">
          {loading ? (
            <tr><td colSpan={6} style={{ textAlign: 'center', padding: '1.2rem', color: 'var(--dim)' }}>Loading…</td></tr>
          ) : !rows.length ? (
            <tr><td colSpan={6}>
              <div className="empty" style={{ padding: '1.5rem' }}>
                <h3>No GST data yet</h3>
                <p>GST breakdown appears after your first orders</p>
              </div>
            </td></tr>
          ) : (
            rows.map((m, idx) => (
              <tr key={m.month || idx}>
                <td style={{ fontWeight: 600, fontSize: '.8rem' }}>{m.month}</td>
                <td>{formatINR(m.food_gst)}</td>
                <td>{formatINR(m.packaging_gst)}</td>
                <td>{formatINR(m.delivery_gst)}</td>
                <td>{formatINR(m.platform_fee_gst)}</td>
                <td><strong>{formatINR(m.total_gst)}</strong></td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

interface TdsPanelProps { rows: TdsRow[]; loading: boolean }

function TdsPanel({ rows, loading }: TdsPanelProps) {
  return (
    <div className="tbl">
      <table>
        <thead>
          <tr>
            <th>Settlement</th>
            <th>Period</th>
            <th>Gross</th>
            <th>TDS Rate</th>
            <th>TDS Amount</th>
            <th>Certificate</th>
          </tr>
        </thead>
        <tbody id="fin-tds-body">
          {loading ? (
            <tr><td colSpan={6} style={{ textAlign: 'center', padding: '1.2rem', color: 'var(--dim)' }}>Loading…</td></tr>
          ) : !rows.length ? (
            <tr><td colSpan={6}>
              <div className="empty" style={{ padding: '1.5rem' }}>
                <h3>No TDS records yet</h3>
                <p>TDS is deducted from settlements</p>
              </div>
            </td></tr>
          ) : (
            rows.map((t, idx) => (
              <tr key={t.settlement_id || idx}>
                <td style={{ fontFamily: 'monospace', fontSize: '.75rem' }}>{t.settlement_id || '—'}</td>
                <td style={{ fontSize: '.8rem' }}>{t.period || ''}</td>
                <td>{formatINR(t.gross)}</td>
                <td>{t.tds_rate || '1%'}</td>
                <td><strong>{formatINR(t.tds_amount)}</strong></td>
                <td>
                  {t.certificate_url ? (
                    <a
                      href={t.certificate_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-g btn-sm"
                      style={{ textDecoration: 'none' }}
                    >
                      📄 Download
                    </a>
                  ) : (
                    <span style={{ color: 'var(--mute,var(--dim))', fontSize: '.75rem' }}>Pending</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

interface InfoPanelProps { data: TaxSummary | null; loading: boolean }

function InfoPanel({ data, loading }: InfoPanelProps) {
  return (
    <div className="cb">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.2rem' }}>
        <div style={{ background: 'var(--ink4)', border: '1px solid var(--rim)', borderRadius: 8, padding: '1rem 1.2rem' }}>
          <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: '.5rem' }}>
            GSTIN on File
          </div>
          <div id="fin-tax-gstin" style={{ fontSize: '1.05rem', fontWeight: 700, fontFamily: "'SF Mono',monospace", color: 'var(--tx)' }}>
            {loading ? '…' : (data?.gstin || '—')}
          </div>
          <div id="fin-tax-gst-status" style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.2rem' }}>
            {data?.gstin_status ? `Status: ${data.gstin_status}` : ''}
          </div>
        </div>
        <div style={{ background: 'var(--ink4)', border: '1px solid var(--rim)', borderRadius: 8, padding: '1rem 1.2rem' }}>
          <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: '.5rem' }}>
            PAN on File
          </div>
          <div id="fin-tax-pan" style={{ fontSize: '1.05rem', fontWeight: 700, fontFamily: "'SF Mono',monospace", color: 'var(--tx)' }}>
            {loading ? '…' : (data?.pan || '—')}
          </div>
          <div id="fin-tax-pan-status" style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.2rem' }}>
            {data?.pan_status ? `Status: ${data.pan_status}` : ''}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TaxSummarySection() {
  const [activeTab, setActiveTab] = useState<string>('gst');
  const { data, loading, error, refetch } = useAnalyticsFetch<TaxSummary | null>(
    useCallback(() => getTaxSummary() as Promise<TaxSummary | null>, []),
    [],
  );

  const gstRows = data?.gst_monthly || [];
  const tdsRows = data?.tds_records || [];

  return (
    <div className="card">
      <div className="ch"><h3>Tax Compliance</h3></div>
      <div style={{ padding: '.7rem 1.2rem', borderBottom: '1px solid var(--rim)', display: 'flex', gap: '.3rem' }}>
        {TABS.map(([v, l]) => (
          <button
            key={v}
            type="button"
            className={activeTab === v ? 'chip fin-tax-tab on' : 'chip fin-tax-tab'}
            onClick={() => setActiveTab(v)}
          >
            {l}
          </button>
        ))}
      </div>

      {error ? (
        <div className="cb"><SectionError message={error} onRetry={refetch} /></div>
      ) : (
        <>
          {activeTab === 'gst' && (
            <div className="fin-tax-panel" id="fin-tax-gst">
              <GstPanel rows={gstRows} loading={loading && !data} />
            </div>
          )}
          {activeTab === 'tds' && (
            <div className="fin-tax-panel" id="fin-tax-tds">
              <TdsPanel rows={tdsRows} loading={loading && !data} />
            </div>
          )}
          {activeTab === 'info' && (
            <div className="fin-tax-panel" id="fin-tax-info">
              <InfoPanel data={data} loading={loading && !data} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
