'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../Toast';
import { getMe } from '../../../api/auth';
import { routeByStatus } from '../../../utils/routeByStatus';
import type { AuthUser, WabaAccount } from '../../../types';

interface PgPendingProps {
  onLogout?: () => void;
  showPage?: (id: string) => void;
}

type LooseMe = AuthUser & { error?: string };

export default function PgPending({ onLogout, showPage }: PgPendingProps) {
  const router = useRouter();
  const { user, login } = useAuth();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const wabaList = (user?.waba_accounts as WabaAccount[] | undefined) || [];
  const waConnected = Boolean(user?.meta_user_id || wabaList.length > 0);
  const firstPhone = (wabaList[0] as { phone?: string } | undefined)?.phone;
  const fallbackWabaId = (typeof user?.meta_waba_id === 'string' && user.meta_waba_id) || '';
  const waPhone = firstPhone || fallbackWabaId;

  const navigate = (path: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) router.replace(path);
    else router.push(path);
  };

  const handleCheckStatus = async () => {
    if (busy) return;
    setBusy(true);
    showToast('Checking…', 'info');
    try {
      const me = (await getMe()) as LooseMe;
      if (!me || me.error) {
        showToast(me?.error || 'Could not check status', 'error');
        return;
      }
      const token = typeof window !== 'undefined' ? window.localStorage.getItem('zm_token') : null;
      if (token) login(token, me);
      routeByStatus(me, { navigate, ...(showPage && { showPage }) });
    } catch (err: unknown) {
      const e = err as { userMessage?: string; message?: string };
      showToast(e?.userMessage || e?.message || 'Could not check status', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="pg-pending" className="status-wrap">
      <div className="status-card">
        <div className="status-icon">⏳</div>
        <h2>Application Under Review</h2>
        <p>
          Thank you for registering. Our team is reviewing your details and will activate your account within 1–2 business days.
        </p>

        {waConnected ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '.7rem 1.1rem', margin: '.5rem 0 1.2rem', fontSize: '.84rem' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', display: 'inline-block', flexShrink: 0 }}></span>
            <span>WhatsApp connected — <strong>{waPhone || 'WhatsApp Business Account'}</strong></span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', background: '#fefce8', border: '1px solid #fde047', borderRadius: 10, padding: '.7rem 1.1rem', margin: '.5rem 0 1.2rem', fontSize: '.84rem' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#eab308', display: 'inline-block', flexShrink: 0 }}></span>
            <span>
              WhatsApp not connected yet —{' '}
              <button type="button" className="btn-link" onClick={() => showPage?.('pg-connect')}>
                connect now →
              </button>
            </span>
          </div>
        )}

        <ul className="tl-list">
          <li><div className="tl-dot done">✓</div><span>Account created</span></li>
          <li><div className="tl-dot done">✓</div><span>Business details submitted</span></li>
          <li>
            <div className={`tl-dot ${waConnected ? 'done' : 'wait'}`}>{waConnected ? '✓' : '○'}</div>
            <span style={waConnected ? undefined : { color: 'var(--dim)' }}>WhatsApp Business connected</span>
          </li>
          <li><div className="tl-dot wait">○</div><span style={{ color: 'var(--dim)' }}>Admin review &amp; approval</span></li>
          <li><div className="tl-dot wait">○</div><span style={{ color: 'var(--dim)' }}>Dashboard access granted</span></li>
        </ul>

        <div className="btn-row">
          <button type="button" className="btn-outline" onClick={handleCheckStatus} disabled={busy}>
            {busy ? 'Checking…' : 'Check Status'}
          </button>
          <button type="button" className="btn-outline" onClick={onLogout}>Sign Out</button>
        </div>
      </div>
    </div>
  );
}
