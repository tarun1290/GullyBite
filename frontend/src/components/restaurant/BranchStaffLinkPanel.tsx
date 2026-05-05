'use client';

// Branch staff-login link manager. Owner clicks "Generate" to mint a
// per-branch UUID; the resulting URL ({FRONTEND_URL}/staff/{token}) is
// what staff open on their tablet to reach the name + PIN sign-in
// screen. Regenerating replaces the URL but does NOT log out staff
// already signed in (their JWTs carry branchId, not the token).
//
// Mounted only in EDIT mode of BranchFormModal — a brand-new branch
// has no `branchId` yet so the link can't be fetched/generated.

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../Toast';
import { getBranchStaffLink, generateBranchStaffLink } from '../../api/restaurant';
import type { BranchStaffLink } from '../../types';

interface BranchStaffLinkPanelProps {
  branchId: string;
}

function formatGeneratedAt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function BranchStaffLinkPanel({ branchId }: BranchStaffLinkPanelProps) {
  const { showToast } = useToast();

  const [link, setLink] = useState<BranchStaffLink | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Initial fetch.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getBranchStaffLink(branchId);
      setLink(res);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setError(e?.response?.data?.error || e?.message || 'Failed to load staff link');
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  const doGenerate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await generateBranchStaffLink(branchId);
      setLink(res);
      showToast('Staff link generated', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const msg = e?.response?.data?.error || e?.message || 'Failed to generate staff link';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  const doRegenerate = async () => {
    if (busy) return;
    const ok = window.confirm(
      'Regenerating the link will not log out current staff sessions, but new logins must use the new link. Continue?',
    );
    if (!ok) return;
    await doGenerate();
  };

  const doCopy = async () => {
    if (!link?.staff_login_url) return;
    try {
      await navigator.clipboard.writeText(link.staff_login_url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Copy failed — please copy manually', 'error');
    }
  };

  const hasLink = !loading && !!link?.staff_access_token && !!link?.staff_login_url;

  return (
    <div className="card" style={{ marginTop: '1rem' }}>
      <div className="ch">
        <h3 style={{ margin: 0 }}>Staff Login Link</h3>
      </div>
      <div className="cb">
        {loading ? (
          <p style={{ color: 'var(--dim)', fontSize: '.85rem', margin: 0 }}>Loading…</p>
        ) : !hasLink ? (
          // ── State A: no link yet ──
          <>
            <p style={{ color: 'var(--dim)', fontSize: '.85rem', marginTop: 0 }}>
              Generate a secure login link for your branch staff. Share this
              link with staff members — they sign in using their name and PIN.
            </p>
            {error && (
              <p style={{ color: 'var(--gb-red-500,#dc2626)', fontSize: '.82rem', marginBottom: '.5rem' }}>
                {error}
              </p>
            )}
            <button
              type="button"
              className="btn-p btn-sm"
              onClick={doGenerate}
              disabled={busy}
            >
              {busy ? 'Generating…' : 'Generate Staff Link'}
            </button>
          </>
        ) : (
          // ── State B: link exists ──
          <>
            <p style={{ color: 'var(--dim)', fontSize: '.78rem', marginTop: 0, marginBottom: '.6rem' }}>
              Generated {formatGeneratedAt(link!.generated_at)}
            </p>
            <input
              type="text"
              value={link!.staff_login_url || ''}
              readOnly
              onFocus={(e) => e.target.select()}
              style={{
                width: '100%',
                padding: '.5rem .6rem',
                border: '1px solid var(--rim)',
                borderRadius: 6,
                fontSize: '.82rem',
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                background: 'var(--ink2)',
                color: 'var(--fg)',
                marginBottom: '.7rem',
              }}
              aria-label="Staff login URL"
            />
            {error && (
              <p style={{ color: 'var(--gb-red-500,#dc2626)', fontSize: '.82rem', marginBottom: '.5rem' }}>
                {error}
              </p>
            )}
            <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', marginBottom: '.6rem' }}>
              <button
                type="button"
                className="btn-p btn-sm"
                onClick={doCopy}
                disabled={busy}
              >
                {copied ? 'Copied ✓' : 'Copy Link'}
              </button>
              <button
                type="button"
                className="btn-del btn-sm"
                onClick={doRegenerate}
                disabled={busy}
              >
                {busy ? 'Regenerating…' : 'Regenerate'}
              </button>
            </div>
            <p style={{ color: 'var(--dim)', fontSize: '.78rem', margin: 0, lineHeight: 1.5 }}>
              Staff open this link on their device and sign in with their name
              and PIN. Works on Android (with the GullyBite Staff app) and
              iOS/browser.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
