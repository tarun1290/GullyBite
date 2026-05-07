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
      <div className="card mb-[1.2rem]">
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

      <hr className="border-0 border-t border-rim mt-[1.6rem] mb-[1.2rem]" />

      <div className="card mb-[1.2rem] border-rim">
        <div className="ch bg-[#fff1f2]">
          <h3 className="text-[#dc2626]">Delete Account</h3>
        </div>
        <div className="cb">
          <p className="text-[0.84rem] text-dim mb-[0.8rem] leading-[1.65]">
            Permanently delete your GullyBite account, all restaurant data, branches, menu items,
            orders and WhatsApp connections.
            {' '}
            <strong className="text-[#dc2626]">This action cannot be undone.</strong>
          </p>

          {!deleteOpened && (
            <button
              type="button"
              className="btn-g text-[#dc2626] border-[#fecaca]"
              onClick={() => setDeleteOpened(true)}
            >
              Delete Account
            </button>
          )}

          {deleteOpened && (
            <div className="mb-4">
              <label className="text-[0.78rem] font-semibold text-[#dc2626] mb-[0.35rem] block">
                Type your email address to confirm deletion:
              </label>
              <input
                type="email"
                value={deleteEmail}
                onChange={(e) => setDeleteEmail(e.target.value)}
                placeholder={restaurant?.email || 'your-email@example.com'}
                className="w-full py-2 px-3 border border-[#fecaca] rounded-[7px] text-[0.85rem] outline-hidden mb-[0.6rem]"
              />
              <div className="flex gap-[0.6rem]">
                <button
                  type="button"
                  className={`btn-p bg-[#dc2626] flex-1 ${emailMatches ? 'opacity-100' : 'opacity-50'}`}
                  onClick={handleDelete}
                  disabled={deleting || !emailMatches}
                >
                  {deleting ? 'Deleting…' : 'Yes, Delete My Account'}
                </button>
                <button
                  type="button"
                  className="btn-g shrink-0"
                  onClick={() => { setDeleteOpened(false); setDeleteEmail(''); }}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <p className="text-[0.72rem] text-dim mt-2">
            This permanently deletes your restaurant, menu, and all order history. This cannot be
            undone.
          </p>
        </div>
      </div>
    </>
  );
}
