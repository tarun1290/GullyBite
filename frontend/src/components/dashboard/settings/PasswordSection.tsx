'use client';

import { useState, type FormEvent } from 'react';
import { useToast } from '../../Toast';
import { changePassword } from '../../../api/restaurant';

export default function PasswordSection() {
  const { showToast } = useToast();
  const [current, setCurrent] = useState<string>('');
  const [next, setNext] = useState<string>('');
  const [confirm, setConfirm] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

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

  return (
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
  );
}
