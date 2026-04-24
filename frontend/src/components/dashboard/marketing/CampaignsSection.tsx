'use client';

import { useCallback, useState } from 'react';
import useAnalyticsFetch from '../analytics/useAnalyticsFetch';
import SectionError from '../analytics/SectionError';
import { useToast } from '../../Toast';
import {
  getCampaigns,
  getCampaignDailyUsage,
  sendCampaign,
  pauseCampaign,
  resumeCampaign,
  deleteCampaign,
} from '../../../api/restaurant';
import CampaignCreateForm from './CampaignCreateForm';
import CampaignRoiCard from './CampaignRoiCard';

const STATUS_BADGE: Record<string, string> = {
  draft: 'bd',
  scheduled: 'bb',
  sending: 'bb',
  paused: 'bb',
  sent: 'bg',
  failed: 'br',
};

const SEGMENT_LABEL: Record<string, string> = {
  all: 'All',
  recent: 'Recent 30d',
  inactive: 'Inactive 60d+',
  tag: 'Tag (all)',
  any_tag: 'Tag (any)',
};

interface CampaignStats {
  total_recipients?: number;
  sent?: number;
  failed?: number;
  delivered?: number;
  read?: number;
}

interface CampaignRow {
  id?: string;
  _id?: string;
  name: string;
  status?: string;
  segment?: string;
  product_ids?: string[];
  sent_count?: number;
  failed_count?: number;
  stats?: CampaignStats;
  current_batch?: number;
  total_batches?: number;
  pause_reason?: string;
  created_at?: string;
}

interface DailyUsageData {
  sent_today?: number | string;
  daily_cap?: number | string;
  resets_at?: string;
}

interface SendResult {
  sent?: number;
  failed?: number;
}

function timeAgo(iso?: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

interface DailyUsageProps { data: DailyUsageData | null }

function DailyUsage({ data }: DailyUsageProps) {
  if (!data) {
    return (
      <div
        className="card"
        style={{ marginBottom: '1rem', padding: '.8rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}
      >
        <span style={{ fontWeight: 600 }}>Daily sends:</span>
        <span style={{ color: 'var(--dim)' }}>usage unavailable</span>
      </div>
    );
  }
  const sent = Number(data.sent_today) || 0;
  const cap = Number(data.daily_cap) || 0;
  const atCap = cap > 0 && sent >= cap;
  const resetsAt = data.resets_at ? new Date(data.resets_at) : null;
  const resetLabel = resetsAt
    ? (atCap
      ? `Daily limit reached. Resets at ${resetsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
      : 'Resets at midnight IST.')
    : '';
  return (
    <div
      className="card"
      style={{ marginBottom: '1rem', padding: '.8rem 1rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}
    >
      <span style={{ fontWeight: 600 }}>Daily sends:</span>
      <span style={{ color: atCap ? 'var(--red,#dc2626)' : 'var(--dim)' }}>
        <strong>{sent}</strong> of <strong>{cap}</strong> campaigns sent today
      </span>
      {resetLabel && (
        <span style={{ color: 'var(--dim)', fontSize: '.78rem' }}>{resetLabel}</span>
      )}
    </div>
  );
}

type ConfirmKind = 'send' | 'pause' | 'resume' | 'delete' | null;

interface CampaignActionsProps {
  campaign: CampaignRow;
  onChanged?: (() => void) | undefined;
}

function CampaignActions({ campaign, onChanged }: CampaignActionsProps) {
  const { showToast } = useToast();
  const [confirm, setConfirm] = useState<ConfirmKind>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const id = campaign.id || campaign._id || '';

  const run = async (kind: NonNullable<ConfirmKind>) => {
    setBusy(true);
    try {
      if (kind === 'send') {
        const result = (await sendCampaign(id)) as SendResult;
        showToast(`Sent: ${result?.sent ?? 0} delivered, ${result?.failed ?? 0} failed`, 'success');
      } else if (kind === 'pause') {
        await pauseCampaign(id);
        showToast('Campaign paused', 'success');
      } else if (kind === 'resume') {
        await resumeCampaign(id);
        showToast('Campaign resumed — sending in background', 'success');
      } else if (kind === 'delete') {
        await deleteCampaign(id);
        showToast('Campaign deleted', 'success');
      }
      onChanged?.();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || `${kind} failed`, 'error');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const showSend = campaign.status === 'draft' || campaign.status === 'scheduled';
  const showPause = campaign.status === 'sending';
  const showResume = campaign.status === 'paused';
  const showDelete = campaign.status !== 'sending';

  if (confirm) {
    return (
      <div style={{ display: 'inline-flex', gap: '.3rem', whiteSpace: 'nowrap' }}>
        <button type="button" className="btn-g btn-sm" disabled={busy} onClick={() => setConfirm(null)}>
          Cancel
        </button>
        <button
          type="button"
          className={confirm === 'delete' ? 'btn-sm' : 'btn-p btn-sm'}
          style={confirm === 'delete' ? { color: 'var(--red,#dc2626)', fontWeight: 600 } : undefined}
          disabled={busy}
          onClick={() => run(confirm)}
        >
          {busy ? '…' : `Confirm ${confirm}`}
        </button>
      </div>
    );
  }

  return (
    <div style={{ whiteSpace: 'nowrap', display: 'inline-flex', gap: '.3rem' }}>
      {showSend && (
        <button type="button" className="btn-g btn-sm" onClick={() => setConfirm('send')}>Send</button>
      )}
      {showPause && (
        <button
          type="button"
          className="btn-sm"
          style={{ background: '#eab308', color: '#fff' }}
          onClick={() => setConfirm('pause')}
        >
          Pause
        </button>
      )}
      {showResume && (
        <button type="button" className="btn-g btn-sm" onClick={() => setConfirm('resume')}>Resume</button>
      )}
      {showDelete && (
        <button
          type="button"
          className="btn-sm"
          style={{ color: 'var(--red,#dc2626)' }}
          onClick={() => setConfirm('delete')}
        >
          Delete
        </button>
      )}
    </div>
  );
}

interface CampaignRowItemProps {
  campaign: CampaignRow;
  onChanged?: (() => void) | undefined;
}

function CampaignRowItem({ campaign, onChanged }: CampaignRowItemProps) {
  const s = campaign.stats || {};
  const total = s.total_recipients || campaign.sent_count || 0;
  const sentCount = s.sent || campaign.sent_count || 0;
  const failedCount = s.failed || campaign.failed_count || 0;
  const deliveredCount = s.delivered || 0;
  const readCount = s.read || 0;
  const isBatched = (campaign.status === 'sending' || campaign.status === 'paused') && campaign.total_batches;
  const highFail = failedCount > 0 && sentCount > 0 && (failedCount / sentCount) > 0.1;

  return (
    <tr>
      <td>
        <strong>{campaign.name}</strong>
        {isBatched && (
          <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.2rem' }}>
            Batch {campaign.current_batch || 0} / {campaign.total_batches} · {sentCount} / {total} sent
          </div>
        )}
        {sentCount > 0 && (
          <div style={{ fontSize: '.72rem', marginTop: '.2rem' }}>
            <span style={{ color: '#22c55e' }}>
              Delivered: {deliveredCount} ({total > 0 ? Math.round((deliveredCount / sentCount) * 100) : 0}%)
            </span>{' '}
            <span style={{ color: '#3b82f6' }}>
              Read: {readCount} ({sentCount > 0 ? Math.round((readCount / sentCount) * 100) : 0}%)
            </span>{' '}
            <span style={{ color: 'var(--red,#dc2626)' }}>
              Failed: {failedCount} ({sentCount > 0 ? Math.round((failedCount / sentCount) * 100) : 0}%)
            </span>
          </div>
        )}
        {highFail && (
          <div style={{
            background: '#fef2f2', color: '#991b1b', fontSize: '.72rem',
            padding: '.25rem .5rem', borderRadius: 4, marginTop: '.3rem',
          }}
          >
            High failure rate — Meta may be pacing this campaign
          </div>
        )}
        {campaign.status === 'paused' && campaign.pause_reason && (
          <div style={{
            background: '#fef9c3', color: '#854d0e', fontSize: '.72rem',
            padding: '.25rem .5rem', borderRadius: 4, marginTop: '.3rem',
          }}
          >
            {campaign.pause_reason}
          </div>
        )}
      </td>
      <td>{campaign.product_ids?.length || 0}</td>
      <td>{SEGMENT_LABEL[campaign.segment || ''] || campaign.segment}</td>
      <td>{sentCount}</td>
      <td>{failedCount}</td>
      <td>
        <span className={`badge ${STATUS_BADGE[campaign.status || ''] || 'bd'}`}>{campaign.status}</span>
      </td>
      <td style={{ fontSize: '.78rem', color: 'var(--dim)' }}>{timeAgo(campaign.created_at)}</td>
      <td><CampaignActions campaign={campaign} onChanged={onChanged} /></td>
    </tr>
  );
}

export default function CampaignsSection() {
  const campaignsQ = useAnalyticsFetch<CampaignRow[] | null>(
    useCallback(() => getCampaigns() as Promise<CampaignRow[] | null>, []),
    [],
  );
  const usageQ = useAnalyticsFetch<DailyUsageData | null>(
    useCallback(() => getCampaignDailyUsage() as Promise<DailyUsageData | null>, []),
    [],
  );

  const campaigns = Array.isArray(campaignsQ.data) ? campaignsQ.data : [];
  const usage = usageQ.data;
  const atCap = Boolean(usage) && Number(usage?.daily_cap) > 0 && Number(usage?.sent_today) >= Number(usage?.daily_cap);

  const refetchAll = () => {
    campaignsQ.refetch();
    usageQ.refetch();
  };

  return (
    <div>
      <div className="notice wa" style={{ marginBottom: '1.3rem' }}>
        <div className="notice-ico">📢</div>
        <div className="notice-body">
          <h4>WhatsApp Product Campaigns</h4>
          <p>
            Send multi-product messages (MPM) to your customers. Pick products from your menu,
            choose a customer segment, and send or schedule the campaign.
          </p>
        </div>
      </div>

      <div style={{
        background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 8,
        padding: '.85rem 1rem', marginBottom: '1.2rem', fontSize: '.8rem',
        lineHeight: 1.6, color: '#1e3a5f',
      }}
      >
        <strong>Campaign Best Practices (Meta 2026):</strong>
        <br />
        • Segment your audience — targeted messages get better engagement
        <br />
        • Avoid sending the same template to 10K+ users at once
        <br />
        • Meta monitors customer feedback (blocks, reports) and may pause delivery
        <br />
        • Start with a small test batch before sending to your full audience
        <br />
        • Use &quot;Recent&quot; audience (ordered in last 30 days) for best results
      </div>

      <DailyUsage data={usage} />

      <CampaignCreateForm atCap={atCap} onCreated={refetchAll} />

      <div className="card">
        <div className="ch"><h3>Campaign History</h3></div>
        <div className="tbl">
          {campaignsQ.error ? (
            <div style={{ padding: '1rem' }}>
              <SectionError message={campaignsQ.error} onRetry={campaignsQ.refetch} />
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Products</th>
                  <th>Segment</th>
                  <th>Sent</th>
                  <th>Failed</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {campaignsQ.loading && !campaignsQ.data ? (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: '1.2rem', color: 'var(--dim)' }}>Loading…</td></tr>
                ) : campaigns.length === 0 ? (
                  <tr><td colSpan={8}>
                    <div className="empty">
                      <div className="ei">📢</div>
                      <h3>No campaigns yet</h3>
                      <p>Create your first campaign above</p>
                    </div>
                  </td></tr>
                ) : (
                  campaigns.map((c) => (
                    <CampaignRowItem
                      key={c.id || c._id}
                      campaign={c}
                      onChanged={refetchAll}
                    />
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <CampaignRoiCard />
    </div>
  );
}
