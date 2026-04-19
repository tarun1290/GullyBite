import { useAuth } from '../../contexts/AuthContext.jsx';

export default function PgRejected({ onLogout, showPage }) {
  const { user } = useAuth();
  const reason = user?.approval_notes || 'No reason provided.';

  return (
    <div id="pg-rejected" className="status-wrap">
      <div className="status-card">
        <div className="status-icon">❌</div>
        <h2>Application Not Approved</h2>
        <p>
          Your application could not be approved. Please see the reason below and contact us if you have questions.
        </p>
        <div className="rej-box">{reason}</div>
        <p style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
          Contact{' '}
          <a href="mailto:support@gullybite.com" style={{ color: 'var(--acc)' }}>
            support@gullybite.com
          </a>
          {' '}for help or to reapply.
        </p>
        <div className="btn-row">
          <button type="button" className="btn-outline" onClick={() => showPage?.('pg-onboard')}>
            Update &amp; Reapply
          </button>
          <button type="button" className="btn-outline" onClick={onLogout}>Sign Out</button>
        </div>
      </div>
    </div>
  );
}
