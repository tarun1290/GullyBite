import { useCallback, useEffect, useState } from 'react';
import StatCard from '../../components/StatCard.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import {
  sendDineInFeedback,
  getFeedbackStats,
  getFeedbackEscalations,
  resolveFeedbackEscalation,
  getReviewLinks,
  updateReviewLinks,
} from '../../api/restaurant.js';

// Unified feedback & review funnel dashboard.
// Sections: Overview (30d/all-time), Escalation Inbox, Send Dine-in,
// Review Links Settings.

function RatingOverview({ stats, loading, err, onRetry, window, onWindowChange }) {
  if (err) return <SectionError message={err} onRetry={onRetry} />;
  const bySource = stats?.by_source || {};
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
          value={loading ? '\u2014' : `${stats?.average_rating ?? 0} \u2B50`}
          delta={`${stats?.total_ratings || 0} ratings`}
        />
        <StatCard
          label="Positive (4\u20135\u2B50)"
          value={loading ? '\u2014' : (stats?.positive_ratings || 0).toLocaleString()}
          delta={`${stats?.total_ratings ? Math.round(((stats?.positive_ratings || 0) / stats.total_ratings) * 100) : 0}% of replies`}
        />
        <StatCard
          label="Review links sent"
          value={loading ? '\u2014' : (stats?.review_link_sent || 0).toLocaleString()}
          delta="Positive ratings nudged"
        />
        <StatCard
          label="Review clicks"
          value={loading ? '\u2014' : (stats?.review_link_clicks || 0).toLocaleString()}
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
          {['delivery', 'dine_in'].map((src) => (
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
                  {bySource[src]?.avg ?? '\u2014'} \u2B50
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

function EscalationInbox({ escalations, loading, err, onRetry, includeResolved, onToggleResolved, onResolve }) {
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
          <div style={{ fontSize: '.82rem', color: 'var(--dim)' }}>Loading\u2026</div>
        ) : rows.length === 0 ? (
          <div style={{ fontSize: '.82rem', color: 'var(--dim)' }}>
            No open escalations \u2014 nice work.
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

function EscalationRow({ item, onResolve }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
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
          {item.rating ? `${item.rating}\u2B50` : '\u2014'}
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
                {busy ? 'Saving\u2026' : 'Mark resolved'}
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

function SendDineIn({ onSend }) {
  const [phone, setPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [orderRef, setOrderRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function submit(ev) {
    ev.preventDefault();
    setMsg(null);
    if (!phone.trim()) {
      setMsg({ kind: 'err', text: 'Phone is required' });
      return;
    }
    setBusy(true);
    try {
      await onSend({
        phone: phone.trim(),
        customer_name: customerName.trim() || undefined,
        order_ref: orderRef.trim() || undefined,
      });
      setMsg({ kind: 'ok', text: 'Feedback prompt sent via WhatsApp.' });
      setPhone('');
      setCustomerName('');
      setOrderRef('');
    } catch (err) {
      const reason = err?.response?.data?.error || err?.message || 'Send failed';
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
          {busy ? 'Sending\u2026' : 'Send prompt'}
        </button>
      </div>
    </form>
  );
}

function ReviewLinksSettings({ links, onSave }) {
  const [google, setGoogle] = useState(links?.google_review_link || '');
  const [zomato, setZomato] = useState(links?.zomato_review_link || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    setGoogle(links?.google_review_link || '');
    setZomato(links?.zomato_review_link || '');
  }, [links]);

  async function submit(ev) {
    ev.preventDefault();
    setMsg(null);
    setSaving(true);
    try {
      await onSave({
        google_review_link: google.trim() || null,
        zomato_review_link: zomato.trim() || null,
      });
      setMsg({ kind: 'ok', text: 'Review links saved.' });
    } catch (err) {
      const reason = err?.response?.data?.error || err?.message || 'Save failed';
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
            placeholder="https://g.page/r/\u2026/review"
            value={google}
            onChange={(ev) => setGoogle(ev.target.value)}
            style={{ padding: '.45rem .55rem', border: '1px solid var(--rim)', borderRadius: 'var(--r)', background: '#fff' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Zomato review URL</span>
          <input
            type="url"
            placeholder="https://www.zomato.com/\u2026"
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
          {saving ? 'Saving\u2026' : 'Save links'}
        </button>
      </div>
    </form>
  );
}

export default function FeedbackTab() {
  const [window, setWindow] = useState('30d');
  const [stats, setStats] = useState(null);
  const [statsErr, setStatsErr] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [includeResolved, setIncludeResolved] = useState(false);
  const [escalations, setEscalations] = useState([]);
  const [escErr, setEscErr] = useState(null);
  const [escLoading, setEscLoading] = useState(true);

  const [links, setLinks] = useState(null);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsErr(null);
    try {
      const params = window === '30d' ? { window: '30d' } : {};
      const data = await getFeedbackStats(params);
      setStats(data || null);
    } catch (err) {
      setStatsErr(err?.response?.data?.error || err?.message || 'Could not load stats');
    } finally {
      setStatsLoading(false);
    }
  }, [window]);

  const loadEscalations = useCallback(async () => {
    setEscLoading(true);
    setEscErr(null);
    try {
      const data = await getFeedbackEscalations({ include_resolved: includeResolved });
      setEscalations(data?.escalations || []);
    } catch (err) {
      setEscErr(err?.response?.data?.error || err?.message || 'Could not load escalations');
    } finally {
      setEscLoading(false);
    }
  }, [includeResolved]);

  const loadLinks = useCallback(async () => {
    try {
      const data = await getReviewLinks();
      setLinks(data);
    } catch (_) {
      setLinks({ google_review_link: null, zomato_review_link: null });
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadEscalations(); }, [loadEscalations]);
  useEffect(() => { loadLinks(); }, [loadLinks]);

  async function handleSend(body) {
    await sendDineInFeedback(body);
    // Stats and escalations refresh on their normal cycle; no-op here.
  }

  async function handleResolve(id, note) {
    await resolveFeedbackEscalation(id, note || undefined);
    await loadEscalations();
  }

  async function handleSaveLinks(body) {
    const next = await updateReviewLinks(body);
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
