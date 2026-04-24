'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '../../Toast';
import { useRestaurant } from '../../../contexts/RestaurantContext';
import { changePassword, deleteAccount } from '../../../api/restaurant';

export default function PasswordSection() {
  const { showToast } = useToast();
  const { restaurant } = useRestaurant();
  const router = useRouter();

  // ── Change-password form state ─────────────────────────────
  const [current, setCurrent] = useState<string>('');
  const [next, setNext] = useState<string>('');
  const [confirm, setConfirm] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  // ── Delete-account form state ──────────────────────────────
  const [deleteOpened, setDeleteOpened] = useState<boolean>(false);
  const [deleteEmail, setDeleteEmail] = useState<string>('');
  const [deleting, setDeleting] = useState<boolean>(false);

  const actualEmail = (restaurant?.email || '').trim().toLowerCase();
  const typedEmail = deleteEmail.trim().toLowerCase();
  const emailMatches = !!typedEmail && typedEmail === actualEmail;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!next || next.length < 8) {
      showToast('New password must be at least 8 characters', 'error');
      return;
    }
    if (next !== confirm) {
      showToast('Passwords do not match', 'error');
      return;
    }
    setBusy(true);
    try {
      const d = (await changePassword({ currentPassword: current, newPassword: next })) as { ok?: boolean; error?: string } | null;
      if (d?.ok) {
        showToast('Password updated!', 'success');
        setCurrent('');
        setNext('');
        setConfirm('');
      } else {
        showToast(d?.error || 'Failed', 'error');
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!emailMatches) {
      showToast('Email does not match — please type your account email to confirm', 'error');
      return;
    }
    setDeleting(true);
    try {
      await deleteAccount();
      showToast('Account deleted', 'success');
      try { localStorage.removeItem('zm_token'); } catch { /* noop */ }
      setTimeout(() => { router.replace('/'); }, 1000);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to delete account', 'error');
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="card" style={{ marginBottom: '1.2rem' }}>
        <div className="ch"><h3>Change Password</h3></div>
        <div className="cb">
          <form onSubmit={handleSubmit}>
            <div className="fld">
              <label>Current Password</label>
              <input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                placeholder="Enter current password"
                autoComplete="current-password"
              />
            </div>
            <div className="fld">
              <label>New Password</label>
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="Min 8 characters"
                autoComplete="new-password"
              />
            </div>
            <div className="fld">
              <label>Confirm New Password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter new password"
                autoComplete="new-password"
              />
            </div>
            <button type="submit" className="btn-p" disabled={busy}>
              {busy ? 'Updating…' : 'Update Password'}
            </button>
          </form>
        </div>
      </div>

      <hr style={{ border: 0, borderTop: '1px solid var(--rim)', margin: '1.6rem 0 1.2rem' }} />

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

          {!deleteOpened && (
            <button
              type="button"
              className="btn-g"
              style={{ color: '#dc2626', borderColor: '#fecaca' }}
              onClick={() => setDeleteOpened(true)}
            >
              Delete Account
            </button>
          )}

          {deleteOpened && (
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
                value={deleteEmail}
                onChange={(e) => setDeleteEmail(e.target.value)}
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
                  disabled={deleting || !emailMatches}
                >
                  {deleting ? 'Deleting…' : 'Yes, Delete My Account'}
                </button>
                <button
                  type="button"
                  className="btn-g"
                  style={{ flexShrink: 0 }}
                  onClick={() => { setDeleteOpened(false); setDeleteEmail(''); }}
                  disabled={deleting}
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
    </>
  );
}
