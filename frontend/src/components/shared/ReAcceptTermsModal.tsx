'use client';

import { useState } from 'react';
import { TERMS_VERSION, PRIVACY_VERSION } from '../../lib/constants/legal';
import { reacceptConsent } from '../../api/restaurant';

interface ReAcceptTermsModalProps {
  /** Controlled by the dashboard layout's version check. */
  open: boolean;
  /** Called after the backend records the new consent successfully. */
  onAccepted: () => void;
  /** Standard logout flow (the only other way out of this modal). */
  onLogout: () => void;
}

/**
 * Non-dismissable re-acceptance gate. Renders a near-opaque full-screen
 * overlay so the dashboard underneath cannot be clicked or navigated.
 * Deliberately has NO close button, NO Escape handler, and NO
 * click-outside-to-close — the only exits are accepting or logging out.
 */
export default function ReAcceptTermsModal({
  open,
  onAccepted,
  onLogout,
}: ReAcceptTermsModalProps) {
  const [checked, setChecked] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleAccept = async () => {
    if (!checked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await reacceptConsent({
        terms_version: TERMS_VERSION,
        privacy_version: PRIVACY_VERSION,
        accepted_at: new Date().toISOString(),
      });
      onAccepted();
    } catch {
      setError('Could not record acceptance. Please try again or contact support.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reaccept-title"
    >
      <div className="w-full max-w-md rounded-xl bg-surface p-6 shadow-2xl">
        <h2 id="reaccept-title" className="text-xl font-bold text-tx">
          Updated Terms &amp; Privacy Policy
        </h2>

        <p className="mt-3 text-sm leading-6 text-dim">
          We have updated our{' '}
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-acc underline"
          >
            Terms of Service
          </a>{' '}
          and{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-acc underline"
          >
            Privacy Policy
          </a>{' '}
          following our transition out of the beta program. Please review and
          accept the updated documents to continue using GullyBite.
        </p>

        <label className="mt-5 flex cursor-pointer items-start gap-2 text-sm text-tx">
          <input
            type="checkbox"
            className="mt-0.5 shrink-0"
            checked={checked}
            onChange={(e) => {
              setChecked(e.target.checked);
              if (e.target.checked) setError(null);
            }}
          />
          <span>
            I have read and agree to the updated Terms of Service and Privacy
            Policy.
          </span>
        </label>

        {error && (
          <p className="mt-3 text-sm text-red" role="alert">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            onClick={handleAccept}
            disabled={!checked || submitting}
            className="inline-flex items-center justify-center rounded-lg bg-acc px-4 py-2.5 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 sm:flex-1"
          >
            {submitting ? 'Recording…' : 'Accept and Continue'}
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center justify-center rounded-lg border border-rim px-4 py-2.5 text-sm font-medium text-tx transition hover:bg-surface2 sm:flex-1"
          >
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}
