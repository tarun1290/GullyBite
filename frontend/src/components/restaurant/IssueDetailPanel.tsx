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
  display_order_id?: string;
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
    return <span className="text-green-600">✓</span>;
  }
  if (!issue.sla_deadline) return '—';
  const remaining = new Date(issue.sla_deadline).getTime() - Date.now();
  if (remaining <= 0) return <span className="text-red-600 font-semibold">🔴 Breached</span>;
  const hrs = Math.floor(remaining / 3600000);
  const mins = Math.floor((remaining % 3600000) / 60000);
  if (remaining < 3600000) return <span className="text-red-600">🟡 {mins}m left</span>;
  if (hrs < 6) return <span className="text-[#f59e0b]">🟡 {hrs}h {mins}m</span>;
  return <span className="text-green-600">🟢 {hrs}h</span>;
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
      <div className="text-center text-[0.72rem] text-dim py-[0.2rem]">
        {msg.text}
      </div>
    );
  }
  const bubbleBg = isCust
    ? 'bg-ink3'
    : msg.internal
      ? 'bg-[rgba(139,92,246,0.1)]'
      : 'bg-[rgba(37,211,102,0.12)]';
  const bubbleBorder = msg.internal ? 'border border-dashed border-[rgba(139,92,246,0.3)]' : '';
  const align = isCust ? 'self-start' : 'self-end';
  return (
    <div
      className={`max-w-[80%] py-[0.4rem] px-[0.6rem] rounded-[10px] text-[0.82rem] leading-[1.4] ${align} ${bubbleBg} ${bubbleBorder}`}
    >
      <div className="text-[0.65rem] font-semibold text-dim mb-[0.15rem]">
        {msg.sender_name}
        {msg.internal && ' (internal)'}
      </div>
      <div>{msg.text}</div>
      <div className="text-[0.6rem] text-dim text-right mt-[0.15rem]">
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
    <div className="mt-2 p-[0.6rem] border border-[#fca5a5] bg-[#fef2f2] rounded-lg">
      <div className="text-[0.75rem] font-semibold text-[#991b1b] mb-[0.4rem]">
        Escalate to GullyBite admin
      </div>
      <textarea
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for escalation"
        className="w-full py-[0.4rem] px-2 border border-rim rounded-md text-[0.8rem] font-[inherit]"
      />
      <div className="flex gap-[0.4rem] mt-[0.4rem] justify-end">
        <button type="button" className="btn-g btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn-p btn-sm bg-red-600 border-red-600"
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
    <div className="mt-2 p-[0.6rem] border border-[#bbf7d0] bg-[#f0fdf4] rounded-lg">
      <div className="text-[0.75rem] font-semibold text-[#166534] mb-[0.4rem]">
        Resolve issue
      </div>
      <label className="block text-[0.7rem] text-dim mb-[0.2rem]">
        Resolution type
      </label>
      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        className="w-full py-[0.35rem] px-2 border border-rim rounded-md text-[0.8rem] mb-[0.4rem]"
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
        className="w-full py-[0.4rem] px-2 border border-rim rounded-md text-[0.8rem] font-[inherit]"
      />
      <div className="flex gap-[0.4rem] mt-[0.4rem] justify-end">
        <button type="button" className="btn-g btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn-p btn-sm bg-green-600 border-green-600"
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
      <div className="text-center text-dim py-12 text-[0.85rem]">
        Select an issue to view details
      </div>
    );
  }

  if (loading && !issue) {
    return <div className="spin my-8 mx-auto block w-[22px] h-[22px]" />;
  }

  if (!issue) {
    return <div className="p-4 text-red text-[0.82rem]">Issue not found</div>;
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
    <div className="py-4 px-[1.2rem] overflow-y-auto h-full">
      <div className="flex items-center gap-[0.7rem] flex-wrap mb-[0.8rem]">
        <span className="font-bold text-[0.95rem]">{issue.issue_number}</span>
        <span className="text-[0.78rem] py-[0.15rem] px-2 rounded-md bg-ink3">
          {CAT_LABEL[issue.category || ''] || issue.category}
        </span>
        <span
          className="text-[0.72rem] font-bold py-[0.12rem] px-[0.4rem] rounded-sm uppercase"
          // priority bg/colour from PRI_BG/PRI_CLR by issue.priority at runtime
          // (critical/high/medium/low — 4 distinct rgba/hex pairs).
          style={{ background: priBg, color: priClr }}
        >
          {issue.priority}
        </span>
        <span
          className="text-[0.72rem] font-semibold py-[0.12rem] px-[0.4rem] rounded-sm text-white"
          // status bg from ST_CLR by issue.status at runtime
          // (open/assigned/in_progress/.../closed — 8 distinct hex).
          style={{ background: stClr }}
        >
          {(issue.status || '').replace(/_/g, ' ')}
        </span>
        <span className="text-[0.72rem] ml-auto">{slaLabel(issue)}</span>
      </div>

      <div className="flex gap-6 text-[0.82rem] flex-wrap pb-[0.7rem] border-b border-rim">
        <div><span className="text-dim">Customer:</span> <strong>{issue.customer_name || 'Unknown'}</strong></div>
        <div><span className="text-dim">Phone:</span> {issue.customer_phone || '—'}</div>
        <div><span className="text-dim">Order:</span> {issue.display_order_id || '—'}</div>
      </div>

      <div className="py-[0.8rem] border-b border-rim">
        <div className="text-[0.72rem] text-dim mb-[0.3rem] uppercase font-semibold">
          Description
        </div>
        <div className="text-[0.85rem] leading-normal">{issue.description || ''}</div>
        {Array.isArray(issue.media) && issue.media.length > 0 && (
          <div className="mt-[0.4rem] flex gap-[0.4rem] flex-wrap">
            {issue.media.map((m, idx) => (
              <div key={m.media_id || idx} className="w-20 h-20 bg-ink3 rounded-md flex items-center justify-center">
                {m.media_type === 'image' ? '📷' : `${m.media_type}`}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="py-[0.8rem] border-b border-rim">
        <div className="text-[0.72rem] text-dim mb-2 uppercase font-semibold">
          Communication
        </div>
        <div className="max-h-[300px] overflow-y-auto flex flex-col gap-[0.35rem]">
          {(issue.messages || []).map((m, idx) => (
            <IssueMessage key={m._id || m.id || idx} msg={m} />
          ))}
        </div>
        <form
          onSubmit={handleSend}
          className="mt-[0.6rem] flex gap-[0.4rem] items-center flex-wrap"
        >
          <input
            id="iss-d-reply"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Type a response…"
            disabled={sending}
            className="flex-1 min-w-[200px] py-[0.45rem] px-[0.65rem] border border-rim rounded-lg text-[0.82rem]"
          />
          <label className="text-[0.72rem] flex items-center gap-[0.2rem] text-dim cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
              className="accent-wa"
            />
            Internal
          </label>
          <button type="submit" className="btn-p btn-sm" disabled={sending || !replyText.trim()}>
            {sending ? '…' : 'Send'}
          </button>
        </form>
      </div>

      <div className="py-[0.8rem] flex gap-[0.4rem] flex-wrap">
        {canAct && (
          <>
            <button
              type="button"
              className="btn-g btn-sm text-red-600 border-red-600"
              onClick={() => setMode(mode === 'escalate' ? null : 'escalate')}
              disabled={busy}
            >
              Escalate to GullyBite
            </button>
            <button
              type="button"
              className="btn-g btn-sm text-green-600 border-green-600"
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
