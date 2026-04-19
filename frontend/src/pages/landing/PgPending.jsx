import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { getMe } from '../../api/auth.js';
import { routeByStatus } from '../../utils/routeByStatus.js';

export default function PgPending({ onLogout, showPage }) {
  const navigate = useNavigate();
  const { user, login } = useAuth();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const waConnected = !!(user?.meta_user_id || (user?.waba_accounts && user.waba_accounts.length > 0));
  const waPhone = user?.waba_accounts?.[0]?.phone || user?.meta_waba_id || '';

  const handleCheckStatus = async () => {
    if (busy) return;
    setBusy(true);
    showToast('Checking…', 'info');
    try {
      const me = await getMe();
      if (!me || me.error) {
        showToast(me?.error || 'Could not check status', 'error');
        return;
      }
      const token = localStorage.getItem('zm_token');
      if (token) login(token, me);
      routeByStatus(me, { showPage, navigate });
    } catch (err) {
      showToast(err?.userMessage || err?.message || 'Could not check status', 'error');
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
