'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  getIssueById,
  replyToIssue,
  resolveIssue,
  escalateIssue,
  reopenIssue,
} from '../../api/restaurant';
import { useToast } from '../Toast';
import { CAT_LABEL, PRI_CLR, ST_CLR } from './IssueList';

// Mirrors openIssDetail() + sendIssMsg() + issEscalate() + issResolve() + issAction('reopened')
// in legacy messages.js:352-465. Legacy uses window.prompt() for escalation reason and
// resolution_type; we replace with inline forms (two-click reveal) to match the
// "no native dialogs" convention set in Phase 2e.
const PRI_BG: Record<string, string> = {
  critical: 'rgba(220,38,38,.1)',
  high: 'rgba(245,158,11,.1)',
  medium: 'rgba(59,130,246,.08)',
  low: 'rgba(148,163,184,.08)',
};

const RESOLUTION_TYPES: ReadonlyArray<string> = [
  'full_refund', 'partial_refund', 'credit', 'replacement',
  'redelivery', 'apology', 'explanation', 'no_action',
];

export interface IssueMessageRow {
  _id?: string;
  id?: string;
  sender_type?: 'customer' | 'system' | 'restaurant' | 'admin';
  sender_name?: string;
  text?: string;
  internal?: boolean;
  created_at?: string;
}

export interface IssueMedia {
  media_id?: string;
  media_type?: string;
}

export interface IssueDetail {
  _id?: string;
  id?: string;
  issue_number?: string;
  category?: string;
  priority?: string;
  status?: string;
  customer_name?: string;
  customer_phone?: string;
  order_number?: string;
  description?: string;
  sla_deadline?: string;
  messages?: IssueMessageRow[];
  media?: IssueMedia[];
}

interface ResolutionPayload {
  resolution_type: string;
  resolution_notes: string;
}

function slaLabel(issue: IssueDetail): React.ReactNode {
  const status = issue.status || '';
  if (['resolved', 'closed'].includes(status)) {
    return <span style={{ color: '#16a34a' }}>✓</span>;
  }
  if (!issue.sla_deadline) return '—';
  const remaining = new Date(issue.sla_deadline).getTime() - Date.now();
  if (remaining <= 0) return <span style={{ color: '#dc2626', fontWeight: 600 }}>🔴 Breached</span>;
  const hrs = Math.floor(remaining / 3600000);
  const mins = Math.floor((remaining % 3600000) / 60000);
  if (remaining < 3600000) return <span style={{ color: '#dc2626' }}>🟡 {mins}m left</span>;
  if (hrs < 6) return <span style={{ color: '#f59e0b' }}>🟡 {hrs}h {mins}m</span>;
  return <span style={{ color: '#16a34a' }}>🟢 {hrs}h</span>;
}

function formatStamp(ts?: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function IssueMessage({ msg }: { msg: IssueMessageRow }) {
  const isCust = msg.sender_type === 'customer';
  const isSys = msg.sender_type === 'system';
  if (isSys) {
    return (
      <div style={{ textAlign: 'center', fontSize: '.72rem', color: 'var(--dim)', padding: '.2rem 0' }}>
        {msg.text}
      </div>
    );
  }
  const bg = isCust ? 'var(--ink3)' : msg.internal ? 'rgba(139,92,246,.1)' : 'rgba(37,211,102,.12)';
  const border = msg.internal ? '1px dashed rgba(139,92,246,.3)' : undefined;
  return (
    <div
      style={{
        alignSelf: isCust ? 'flex-start' : 'flex-end',
        maxWidth: '80%',
        padding: '.4rem .6rem',
        borderRadius: 10,
        background: bg,
        border,
        fontSize: '.82rem',
        lineHeight: 1.4,
      }}
    >
      <div style={{ fontSize: '.65rem', fontWeight: 600, color: 'var(--dim)', marginBottom: '.15rem' }}>
        {msg.sender_name}
        {msg.internal && ' (internal)'}
      </div>
      <div>{msg.text}</div>
      <div style={{ fontSize: '.6rem', color: 'var(--dim)', textAlign: 'right', marginTop: '.15rem' }}>
        {formatStamp(msg.created_at)}
      </div>
    </div>
  );
}

interface EscalateFormProps {
  onSubmit: (reason: string) => void;
  onCancel: () => void;
  busy: boolean;
}

function EscalateForm({ onSubmit, onCancel, busy }: EscalateFormProps) {
  const [reason, setReason] = useState<string>('');
  return (
    <div style={{ marginTop: '.5rem', padding: '.6rem', border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 8 }}>
      <div style={{ fontSize: '.75rem', fontWeight: 600, color: '#991b1b', marginBottom: '.4rem' }}>
        Escalate to GullyBite admin
      </div>
      <textarea
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for escalation"
        style={{ width: '100%', padding: '.4rem .5rem', border: '1px solid var(--rim)', borderRadius: 6, fontSize: '.8rem', fontFamily: 'inherit' }}
      />
      <div style={{ display: 'flex', gap: '.4rem', marginTop: '.4rem', justifyContent: 'flex-end' }}>
        <button type="button" className="btn-g btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn-p btn-sm"
          style={{ background: '#dc2626', borderColor: '#dc2626' }}
          disabled={busy || !reason.trim()}
          onClick={() => onSubmit(reason.trim())}
        >
          {busy ? '…' : 'Escalate'}
        </button>
      </div>
    </div>
  );
}

interface ResolveFormProps {
  onSubmit: (payload: ResolutionPayload) => void;
  onCancel: () => void;
  busy: boolean;
}

function ResolveForm({ onSubmit, onCancel, busy }: ResolveFormProps) {
  const [type, setType] = useState<string>('explanation');
  const [notes, setNotes] = useState<string>('');
  return (
    <div style={{ marginTop: '.5rem', padding: '.6rem', border: '1px solid #bbf7d0', background: '#f0fdf4', borderRadius: 8 }}>
      <div style={{ fontSize: '.75rem', fontWeight: 600, color: '#166534', marginBottom: '.4rem' }}>
        Resolve issue
      </div>
      <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--dim)', marginBottom: '.2rem' }}>
        Resolution type
      </label>
      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        style={{ width: '100%', padding: '.35rem .5rem', border: '1px solid var(--rim)', borderRadius: 6, fontSize: '.8rem', marginBottom: '.4rem' }}
      >
        {RESOLUTION_TYPES.map((r) => (
          <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
        ))}
      </select>
      <textarea
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Resolution notes (optional)"
        style={{ width: '100%', padding: '.4rem .5rem', border: '1px solid var(--rim)', borderRadius: 6, fontSize: '.8rem', fontFamily: 'inherit' }}
      />
      <div style={{ display: 'flex', gap: '.4rem', marginTop: '.4rem', justifyContent: 'flex-end' }}>
        <button type="button" className="btn-g btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn-p btn-sm"
          style={{ background: '#16a34a', borderColor: '#16a34a' }}
          disabled={busy}
          onClick={() => onSubmit({ resolution_type: type, resolution_notes: notes })}
        >
          {busy ? '…' : 'Resolve'}
        </button>
      </div>
    </div>
  );
}

interface IssueDetailPanelProps {
  issueId?: string | null;
  onStatusChange?: () => void;
}

type Mode = 'escalate' | 'resolve' | null;

export default function IssueDetailPanel({ issueId, onStatusChange }: IssueDetailPanelProps) {
  const { showToast } = useToast();
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [replyText, setReplyText] = useState<string>('');
  const [internal, setInternal] = useState<boolean>(false);
  const [sending, setSending] = useState<boolean>(false);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const fetchIssue = useCallback(async () => {
    if (!issueId) return;
    setLoading(true);
    try {
      const data = (await getIssueById(issueId)) as IssueDetail | null;
      setIssue(data);
    } catch (e: unknown) {
      const err = e as { message?: string };
      showToast(err?.message || 'Failed to load issue', 'error');
    } finally {
      setLoading(false);
    }
  }, [issueId, showToast]);

  useEffect(() => {
    setIssue(null);
    setReplyText('');
    setInternal(false);
    setMode(null);
    if (issueId) fetchIssue();
  }, [issueId, fetchIssue]);

  if (!issueId) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--dim)', padding: '3rem 0', fontSize: '.85rem' }}>
        Select an issue to view details
      </div>
    );
  }

  if (loading && !issue) {
    return <div className="spin" style={{ margin: '2rem auto', display: 'block', width: 22, height: 22 }} />;
  }

  if (!issue) {
    return <div style={{ padding: '1rem', color: 'var(--red)', fontSize: '.82rem' }}>Issue not found</div>;
  }

  const priClr = PRI_CLR[issue.priority || ''] || '#94a3b8';
  const priBg  = PRI_BG[issue.priority || ''] || '';
  const stClr  = ST_CLR[issue.status || ''] || '#64748b';
  const status = issue.status || '';
  const canAct = !['resolved', 'closed'].includes(status);
  const canReopen = status === 'resolved';

  const handleSend = async (e: FormEvent<HTMLFormElement>) => {
    e?.preventDefault?.();
    const text = replyText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await replyToIssue(issueId, { text, internal });
      setReplyText('');
      setInternal(false);
      await fetchIssue();
    } catch (err: unknown) {
      const e2 = err as { message?: string };
      showToast(e2?.message || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const runAction = async (fn: () => Promise<unknown>, successMsg: string) => {
    setBusy(true);
    try {
      await fn();
      showToast(successMsg, 'success');
      setMode(null);
      await fetchIssue();
      onStatusChange?.();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e2?.response?.data?.error || e2?.message || 'Action failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = (payload: ResolutionPayload) => runAction(() => resolveIssue(issueId, { ...payload }), 'Issue resolved');
  const handleEscalate = (reason: string) => runAction(() => escalateIssue(issueId, { reason }), 'Issue escalated to admin');
  const handleReopen = () => runAction(() => reopenIssue(issueId), 'Issue reopened');

  return (
    <div style={{ padding: '1rem 1.2rem', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.7rem', flexWrap: 'wrap', marginBottom: '.8rem' }}>
        <span style={{ fontWeight: 700, fontSize: '.95rem' }}>{issue.issue_number}</span>
        <span style={{ fontSize: '.78rem', padding: '.15rem .5rem', borderRadius: 6, background: 'var(--ink3)' }}>
          {CAT_LABEL[issue.category || ''] || issue.category}
        </span>
        <span style={{ fontSize: '.72rem', fontWeight: 700, padding: '.12rem .4rem', borderRadius: 4, background: priBg, color: priClr, textTransform: 'uppercase' }}>
          {issue.priority}
        </span>
        <span style={{ fontSize: '.72rem', fontWeight: 600, padding: '.12rem .4rem', borderRadius: 4, background: stClr, color: '#fff' }}>
          {(issue.status || '').replace(/_/g, ' ')}
        </span>
        <span style={{ fontSize: '.72rem', marginLeft: 'auto' }}>{slaLabel(issue)}</span>
      </div>

      <div style={{ display: 'flex', gap: '1.5rem', fontSize: '.82rem', flexWrap: 'wrap', paddingBottom: '.7rem', borderBottom: '1px solid var(--rim)' }}>
        <div><span style={{ color: 'var(--dim)' }}>Customer:</span> <strong>{issue.customer_name || 'Unknown'}</strong></div>
        <div><span style={{ color: 'var(--dim)' }}>Phone:</span> {issue.customer_phone || '—'}</div>
        <div><span style={{ color: 'var(--dim)' }}>Order:</span> {issue.order_number || '—'}</div>
      </div>

      <div style={{ padding: '.8rem 0', borderBottom: '1px solid var(--rim)' }}>
        <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginBottom: '.3rem', textTransform: 'uppercase', fontWeight: 600 }}>
          Description
        </div>
        <div style={{ fontSize: '.85rem', lineHeight: 1.5 }}>{issue.description || ''}</div>
        {Array.isArray(issue.media) && issue.media.length > 0 && (
          <div style={{ marginTop: '.4rem', display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
            {issue.media.map((m, idx) => (
              <div key={m.media_id || idx} style={{ width: 80, height: 80, background: 'var(--ink3)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {m.media_type === 'image' ? '📷' : `${m.media_type}`}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: '.8rem 0', borderBottom: '1px solid var(--rim)' }}>
        <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginBottom: '.5rem', textTransform: 'uppercase', fontWeight: 600 }}>
          Communication
        </div>
        <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '.35rem' }}>
          {(issue.messages || []).map((m, idx) => (
            <IssueMessage key={m._id || m.id || idx} msg={m} />
          ))}
        </div>
        <form
          onSubmit={handleSend}
          style={{ marginTop: '.6rem', display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' }}
        >
          <input
            id="iss-d-reply"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Type a response…"
            disabled={sending}
            style={{ flex: 1, minWidth: 200, padding: '.45rem .65rem', border: '1px solid var(--rim)', borderRadius: 8, fontSize: '.82rem' }}
          />
          <label style={{ fontSize: '.72rem', display: 'flex', alignItems: 'center', gap: '.2rem', color: 'var(--dim)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
              style={{ accentColor: 'var(--wa)' }}
            />
            Internal
          </label>
          <button type="submit" className="btn-p btn-sm" disabled={sending || !replyText.trim()}>
            {sending ? '…' : 'Send'}
          </button>
        </form>
      </div>

      <div style={{ padding: '.8rem 0', display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
        {canAct && (
          <>
            <button
              type="button"
              className="btn-g btn-sm"
              style={{ color: '#dc2626', borderColor: '#dc2626' }}
              onClick={() => setMode(mode === 'escalate' ? null : 'escalate')}
              disabled={busy}
            >
              Escalate to GullyBite
            </button>
            <button
              type="button"
              className="btn-g btn-sm"
              style={{ color: '#16a34a', borderColor: '#16a34a' }}
              onClick={() => setMode(mode === 'resolve' ? null : 'resolve')}
              disabled={busy}
            >
              Resolve
            </button>
          </>
        )}
        {canReopen && (
          <button type="button" className="btn-g btn-sm" onClick={handleReopen} disabled={busy}>
            {busy ? '…' : 'Reopen'}
          </button>
        )}
      </div>

      {mode === 'escalate' && (
        <EscalateForm onSubmit={handleEscalate} onCancel={() => setMode(null)} busy={busy} />
      )}
      {mode === 'resolve' && (
        <ResolveForm onSubmit={handleResolve} onCancel={() => setMode(null)} busy={busy} />
      )}
    </div>
  );
}
