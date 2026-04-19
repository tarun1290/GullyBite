import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRestaurant } from '../../../contexts/RestaurantContext.jsx';
import { useToast } from '../../Toast.jsx';
import { deleteAccount } from '../../../api/restaurant.js';

// Mirrors doDeleteAccount() in legacy settings.js:1553-1570. Client-side
// confirmation: user must type their email verbatim to enable the delete.
// On success: clear zm_token (our auth token key), then redirect to "/".
export default function DangerZoneSection() {
  const { restaurant } = useRestaurant();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [opened, setOpened] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const actualEmail = (restaurant?.email || '').trim().toLowerCase();
  const typedEmail = email.trim().toLowerCase();
  const emailMatches = typedEmail && typedEmail === actualEmail;

  const handleDelete = async () => {
    if (!emailMatches) {
      showToast('Email does not match — please type your account email to confirm', 'error');
      return;
    }
    setBusy(true);
    try {
      await deleteAccount();
      showToast('Account deleted', 'success');
      try { localStorage.removeItem('zm_token'); } catch (_) { /* noop */ }
      setTimeout(() => { navigate('/', { replace: true }); }, 1000);
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to delete account', 'error');
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: '1.2rem', borderColor: 'var(--rim)' }}>
      <div className="ch" style={{ background: '#fff1f2' }}>
        <h3 style={{ color: '#dc2626' }}>Delete Account</h3>
      </div>
      <div className="cb">
        <p style={{
          fontSize: '.84rem', color: 'var(--dim)', marginBottom: '.8rem', lineHeight: 1.65,
        }}
        >
          Permanently delete your GullyBite account, all restaurant data, branches, menu items,
          orders and WhatsApp connections.
          {' '}
          <strong style={{ color: '#dc2626' }}>This action cannot be undone.</strong>
        </p>

        {!opened && (
          <button
            type="button"
            className="btn-g"
            style={{ color: '#dc2626', borderColor: '#fecaca' }}
            onClick={() => setOpened(true)}
          >
            Delete Account
          </button>
        )}

        {opened && (
          <div style={{ marginBottom: '1rem' }}>
            <label style={{
              fontSize: '.78rem', fontWeight: 600, color: '#dc2626',
              marginBottom: '.35rem', display: 'block',
            }}
            >
              Type your email address to confirm deletion:
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={restaurant?.email || 'your-email@example.com'}
              style={{
                width: '100%', padding: '.5rem .75rem', border: '1px solid #fecaca',
                borderRadius: 7, fontSize: '.85rem', outline: 'none', marginBottom: '.6rem',
              }}
            />
            <div style={{ display: 'flex', gap: '.6rem' }}>
              <button
                type="button"
                className="btn-p"
                style={{ background: '#dc2626', flex: 1, opacity: emailMatches ? 1 : 0.5 }}
                onClick={handleDelete}
                disabled={busy || !emailMatches}
              >
                {busy ? 'Deleting…' : 'Yes, Delete My Account'}
              </button>
              <button
                type="button"
                className="btn-g"
                style={{ flexShrink: 0 }}
                onClick={() => { setOpened(false); setEmail(''); }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <p style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.5rem' }}>
          This permanently deletes your restaurant, menu, and all order history. This cannot be
          undone.
        </p>
      </div>
    </div>
  );
}
