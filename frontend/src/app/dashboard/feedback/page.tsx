'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import StatCard from '../../../components/StatCard';
import SectionError from '../../../components/dashboard/analytics/SectionError';
import {
  sendDineInFeedback,
  getFeedbackStats,
  getFeedbackEscalations,
  resolveFeedbackEscalation,
  getReviewLinks,
  updateReviewLinks,
} from '../../../api/restaurant';

interface BySourceBucket {
  avg?: number | string;
  count?: number;
}

interface FeedbackStats {
  average_rating?: number | string;
  total_ratings?: number;
  positive_ratings?: number;
  review_link_sent?: number;
  review_link_clicks?: number;
  review_click_rate?: number | string;
  by_source?: Record<string, BySourceBucket>;
}

interface Escalation {
  _id: string;
  rating?: number;
  source?: string;
  customer_phone?: string;
  created_at?: string;
  feedback_text?: string;
  status?: string;
  escalation_note?: string;
}

interface EscalationsResponse {
  escalations?: Escalation[];
}

interface ReviewLinks {
  google_review_link?: string | null;
  zomato_review_link?: string | null;
}

interface DineInBody {
  phone: string;
  customer_name?: string;
  order_ref?: string;
}

type Window = '30d' | 'all';
type MsgState = { kind: 'ok' | 'err'; text: string } | null;

interface RatingOverviewProps {
  stats: FeedbackStats | null;
  loading: boolean;
  err: string | null;
  onRetry: () => void;
  window: Window;
  onWindowChange: (w: Window) => void;
}

function RatingOverview({ stats, loading, err, onRetry, window, onWindowChange }: RatingOverviewProps) {
  if (err) return <SectionError message={err} onRetry={onRetry} />;
  const bySource = stats?.by_source || {};
  const totalRatings = stats?.total_ratings || 0;
  const positive = stats?.positive_ratings || 0;
  const positivePct = totalRatings ? Math.round((positive / totalRatings) * 100) : 0;
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Unified Rating Overview</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '.35rem' }}>
            <button
              type="button"
              className={window === '30d' ? 'btn-p btn-sm' : 'btn-g btn-sm'}
              onClick={() => onWindowChange('30d')}
            >
              30 days
            </button>
            <button
              type="button"
              className={window === 'all' ? 'btn-p btn-sm' : 'btn-g btn-sm'}
              onClick={() => onWindowChange('all')}
            >
              All time
            </button>
          </div>
        </div>
        <div className="cb" style={{ fontSize: '.82rem', color: 'var(--dim)' }}>
          Combines post-delivery ratings and merchant-triggered dine-in feedback into one view.
        </div>
      </div>

      <div className="stats">
        <StatCard
          label="Average rating"
          value={loading ? '—' : `${stats?.average_rating ?? 0} ⭐`}
          delta={`${totalRatings} ratings`}
        />
        <StatCard
          label="Positive (4–5⭐)"
          value={loading ? '—' : positive.toLocaleString()}
          delta={`${positivePct}% of replies`}
        />
        <StatCard
          label="Review links sent"
          value={loading ? '—' : (stats?.review_link_sent || 0).toLocaleString()}
          delta="Positive ratings nudged"
        />
        <StatCard
          label="Review clicks"
          value={loading ? '—' : (stats?.review_link_clicks || 0).toLocaleString()}
          delta={`${stats?.review_click_rate ?? 0}% click-through`}
        />
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="ch"><h3>By source</h3></div>
        <div
          className="cb"
          style={{
            display: 'grid',
            gap: '.6rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          }}
        >
          {(['delivery', 'dine_in'] as const).map((src) => (
            <div
              key={src}
              style={{
                padding: '.7rem .8rem',
                border: '1px solid var(--rim)',
                borderRadius: 'var(--r)',
                background: 'var(--panel)',
              }}
            >
              <div style={{ fontSize: '.76rem', color: 'var(--dim)', textTransform: 'capitalize' }}>
                {src.replace('_', '-')}
              </div>
              <div style={{ marginTop: '.25rem' }}>
                <strong style={{ fontSize: '1.1rem' }}>
                  {bySource[src]?.avg ?? '—'} ⭐
                </strong>
                <span style={{ marginLeft: '.5rem', fontSize: '.8rem', color: 'var(--dim)' }}>
                  {bySource[src]?.count || 0} ratings
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface EscalationInboxProps {
  escalations: Escalation[];
  loading: boolean;
  err: string | null;
  onRetry: () => void;
  includeResolved: boolean;
  onToggleResolved: (v: boolean) => void;
  onResolve: (id: string, note: string) => Promise<void>;
}

function EscalationInbox({ escalations, loading, err, onRetry, includeResolved, onToggleResolved, onResolve }: EscalationInboxProps) {
  if (err) return <SectionError message={err} onRetry={onRetry} />;
  const rows = escalations || [];
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className="ch" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Escalation Inbox</h3>
        <label style={{ marginLeft: 'auto', fontSize: '.78rem', color: 'var(--dim)', display: 'inline-flex', gap: '.35rem', alignItems: 'center' }}>
          <input type="checkbox" checked={includeResolved} onChange={(e) => onToggleResolved(e.target.checked)} />
          Show resolved
        </label>
      </div>
      <div className="cb">
        {loading ? (
          <div style={{ fontSize: '.82rem', color: 'var(--dim)' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ fontSize: '.82rem', color: 'var(--dim)' }}>
            No open escalations — nice work.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
            {rows.map((e) => (
              <EscalationRow key={e._id} item={e} onResolve={onResolve} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface EscalationRowProps {
  item: Escalation;
  onResolve: (id: string, note: string) => Promise<void>;
}

function EscalationRow({ item, onResolve }: EscalationRowProps) {
  const [busy, setBusy] = useState<boolean>(false);
  const [note, setNote] = useState<string>('');
  const [showNote, setShowNote] = useState<boolean>(false);
  const isOpen = item.status === 'escalated';

  async function doResolve() {
    setBusy(true);
    try {
      await onResolve(item._id, note);
    } finally {
      setBusy(false);
      setShowNote(false);
      setNote('');
    }
  }

  return (
    <div
      style={{
        padding: '.65rem .75rem',
        border: '1px solid var(--rim)',
        borderRadius: 'var(--r)',
        background: isOpen ? '#fff7ed' : '#f8fafc',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '.45rem', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '.9rem' }}>
          {item.rating ? `${item.rating}⭐` : '—'}
        </strong>
        <span style={{ fontSize: '.76rem', color: 'var(--dim)' }}>
          {item.source ? item.source.replace('_', '-') : ''}
        </span>
        {item.customer_phone && (
          <span style={{ fontSize: '.76rem', color: 'var(--dim)' }}>
            {item.customer_phone}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: 'var(--dim)' }}>
          {item.created_at ? new Date(item.created_at).toLocaleString() : ''}
        </span>
      </div>
      {item.feedback_text && (
        <div style={{ fontSize: '.82rem', marginTop: '.35rem' }}>{item.feedback_text}</div>
      )}
      {item.status === 'resolved' && item.escalation_note && (
        <div style={{ fontSize: '.76rem', color: 'var(--dim)', marginTop: '.25rem' }}>
          Resolved note: {item.escalation_note}
        </div>
      )}
      {isOpen && (
        <div style={{ marginTop: '.45rem', display: 'flex', gap: '.35rem', alignItems: 'center' }}>
          {showNote ? (
            <>
              <input
                type="text"
                value={note}
                placeholder="Optional note"
                onChange={(ev) => setNote(ev.target.value)}
                style={{ flex: 1, padding: '.35rem .5rem', border: '1px solid var(--rim)', borderRadius: 'var(--r)' }}
              />
              <button type="button" className="btn-p btn-sm" disabled={busy} onClick={doResolve}>
                {busy ? 'Saving…' : 'Mark resolved'}
              </button>
              <button type="button" className="btn-g btn-sm" disabled={busy} onClick={() => { setShowNote(false); setNote(''); }}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="btn-p btn-sm" onClick={() => setShowNote(true)}>
              Mark resolved
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface SendDineInProps {
  onSend: (body: DineInBody) => Promise<void>;
}

function SendDineIn({ onSend }: SendDineInProps) {
  const [phone, setPhone] = useState<string>('');
  const [customerName, setCustomerName] = useState<string>('');
  const [orderRef, setOrderRef] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<MsgState>(null);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setMsg(null);
    if (!phone.trim()) {
      setMsg({ kind: 'err', text: 'Phone is required' });
      return;
    }
    setBusy(true);
    try {
      const body: DineInBody = { phone: phone.trim() };
      if (customerName.trim()) body.customer_name = customerName.trim();
      if (orderRef.trim()) body.order_ref = orderRef.trim();
      await onSend(body);
      setMsg({ kind: 'ok', text: 'Feedback prompt sent via WhatsApp.' });
      setPhone('');
      setCustomerName('');
      setOrderRef('');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const reason = e?.response?.data?.error || e?.message || 'Send failed';
      setMsg({ kind: 'err', text: reason });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: '1rem' }}>
      <div className="ch"><h3>Send Dine-in Feedback</h3></div>
      <div
        className="cb"
        style={{
          display: 'grid',
          gap: '.8rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Customer phone</span>
          <input
            type="tel"
            inputMode="numeric"
            placeholder="91XXXXXXXXXX"
            value={phone}
            onChange={(ev) => setPhone(ev.target.value)}
            style={{ padding: '.45rem .55rem', border: '1px solid var(--rim)', borderRadius: 'var(--r)', background: '#fff' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Customer name (optional)</span>
          <input
            type="text"
            value={customerName}
            onChange={(ev) => setCustomerName(ev.target.value)}
            style={{ padding: '.45rem .55rem', border: '1px solid var(--rim)', borderRadius: 'var(--r)', background: '#fff' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Order / table ref (optional)</span>
          <input
            type="text"
            placeholder="e.g. T4-bill-1288"
            value={orderRef}
            onChange={(ev) => setOrderRef(ev.target.value)}
            style={{ padding: '.45rem .55rem', border: '1px solid var(--rim)', borderRadius: 'var(--r)', background: '#fff' }}
          />
        </label>
      </div>
      {msg && (
        <div className="cb" style={{ color: msg.kind === 'ok' ? 'var(--wa)' : 'var(--red)', fontSize: '.82rem' }}>
          {msg.text}
        </div>
      )}
      <div className="cb" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" className="btn-p btn-sm" disabled={busy}>
          {busy ? 'Sending…' : 'Send prompt'}
        </button>
      </div>
    </form>
  );
}

interface ReviewLinksSettingsProps {
  links: ReviewLinks | null;
  onSave: (body: ReviewLinks) => Promise<void>;
}

function ReviewLinksSettings({ links, onSave }: ReviewLinksSettingsProps) {
  const [google, setGoogle] = useState<string>(links?.google_review_link || '');
  const [zomato, setZomato] = useState<string>(links?.zomato_review_link || '');
  const [saving, setSaving] = useState<boolean>(false);
  const [msg, setMsg] = useState<MsgState>(null);

  useEffect(() => {
    setGoogle(links?.google_review_link || '');
    setZomato(links?.zomato_review_link || '');
  }, [links]);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setMsg(null);
    setSaving(true);
    try {
      await onSave({
        google_review_link: google.trim() || null,
        zomato_review_link: zomato.trim() || null,
      });
      setMsg({ kind: 'ok', text: 'Review links saved.' });
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const reason = e?.response?.data?.error || e?.message || 'Save failed';
      setMsg({ kind: 'err', text: reason });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="ch"><h3>Review Links</h3></div>
      <div className="cb" style={{ fontSize: '.82rem', color: 'var(--dim)' }}>
        Positive ratings trigger a WhatsApp nudge with these links (tracked via a short redirect).
      </div>
      <div
        className="cb"
        style={{
          display: 'grid',
          gap: '.8rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Google review URL</span>
          <input
            type="url"
            placeholder="https://g.page/r/…/review"
            value={google}
            onChange={(ev) => setGoogle(ev.target.value)}
            style={{ padding: '.45rem .55rem', border: '1px solid var(--rim)', borderRadius: 'var(--r)', background: '#fff' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Zomato review URL</span>
          <input
            type="url"
            placeholder="https://www.zomato.com/…"
            value={zomato}
            onChange={(ev) => setZomato(ev.target.value)}
            style={{ padding: '.45rem .55rem', border: '1px solid var(--rim)', borderRadius: 'var(--r)', background: '#fff' }}
          />
        </label>
      </div>
      {msg && (
        <div className="cb" style={{ color: msg.kind === 'ok' ? 'var(--wa)' : 'var(--red)', fontSize: '.82rem' }}>
          {msg.text}
        </div>
      )}
      <div className="cb" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" className="btn-p btn-sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save links'}
        </button>
      </div>
    </form>
  );
}

export default function FeedbackPage() {
  const [window, setWindow] = useState<Window>('30d');
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState<boolean>(true);

  const [includeResolved, setIncludeResolved] = useState<boolean>(false);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [escErr, setEscErr] = useState<string | null>(null);
  const [escLoading, setEscLoading] = useState<boolean>(true);

  const [links, setLinks] = useState<ReviewLinks | null>(null);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsErr(null);
    try {
      const params = window === '30d' ? { window: '30d' } : {};
      const data = (await getFeedbackStats(params)) as FeedbackStats | null;
      setStats(data || null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setStatsErr(e?.response?.data?.error || e?.message || 'Could not load stats');
    } finally {
      setStatsLoading(false);
    }
  }, [window]);

  const loadEscalations = useCallback(async () => {
    setEscLoading(true);
    setEscErr(null);
    try {
      const data = (await getFeedbackEscalations({ include_resolved: includeResolved })) as EscalationsResponse | null;
      setEscalations(data?.escalations || []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setEscErr(e?.response?.data?.error || e?.message || 'Could not load escalations');
    } finally {
      setEscLoading(false);
    }
  }, [includeResolved]);

  const loadLinks = useCallback(async () => {
    try {
      const data = (await getReviewLinks()) as ReviewLinks | null;
      setLinks(data);
    } catch (_e) {
      setLinks({ google_review_link: null, zomato_review_link: null });
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadEscalations(); }, [loadEscalations]);
  useEffect(() => { loadLinks(); }, [loadLinks]);

  async function handleSend(body: DineInBody) {
    await sendDineInFeedback({ ...body });
  }

  async function handleResolve(id: string, note: string) {
    await resolveFeedbackEscalation(id, note || '');
    await loadEscalations();
  }

  async function handleSaveLinks(body: ReviewLinks) {
    const next = (await updateReviewLinks({ ...body })) as ReviewLinks | null;
    setLinks(next);
  }

  return (
    <div id="tab-feedback" className="tab on">
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Feedback</h2>
        <div style={{ fontSize: '.84rem', color: 'var(--dim)', marginTop: '.2rem' }}>
          Every rating from delivery and dine-in, plus the review funnel that follows.
        </div>
      </div>

      <RatingOverview
        stats={stats}
        loading={statsLoading}
        err={statsErr}
        onRetry={loadStats}
        window={window}
        onWindowChange={setWindow}
      />

      <EscalationInbox
        escalations={escalations}
        loading={escLoading}
        err={escErr}
        onRetry={loadEscalations}
        includeResolved={includeResolved}
        onToggleResolved={setIncludeResolved}
        onResolve={handleResolve}
      />

      <SendDineIn onSend={handleSend} />

      <ReviewLinksSettings links={links} onSave={handleSaveLinks} />
    </div>
  );
}
