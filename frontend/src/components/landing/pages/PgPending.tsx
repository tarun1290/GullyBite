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
          <div className="flex items-center gap-[0.6rem] bg-green-50 border border-green-300 rounded-[10px] py-[0.7rem] px-[1.1rem] mt-2 mb-[1.2rem] text-[0.84rem]">
            <span className="w-[10px] h-[10px] rounded-full bg-green-500 inline-block shrink-0"></span>
            <span>WhatsApp connected — <strong>{waPhone || 'WhatsApp Business Account'}</strong></span>
          </div>
        ) : (
          <div className="flex items-center gap-[0.6rem] bg-amber-50 border border-amber-300 rounded-[10px] py-[0.7rem] px-[1.1rem] mt-2 mb-[1.2rem] text-[0.84rem]">
            <span className="w-[10px] h-[10px] rounded-full bg-amber-500 inline-block shrink-0"></span>
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
            <span className={waConnected ? '' : 'text-dim'}>WhatsApp Business connected</span>
          </li>
          <li><div className="tl-dot wait">○</div><span className="text-dim">Admin review &amp; approval</span></li>
          <li><div className="tl-dot wait">○</div><span className="text-dim">Dashboard access granted</span></li>
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
