'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import {
  claimCaptainListing,
  getCaptainListing,
  getCaptainSuggestedListings,
  updateCaptainListing,
  type CaptainListingUpdate,
} from '../../../api/restaurant';
import type { CaptainListingStatus, CaptainSuggestion } from '../../../types';

// Minimal axios-style error envelope. Re-declared here (instead of
// imported) so callers don't depend on axios at the page level — the
// API client surfaces .response.data.error for backend 4xx responses.
interface ApiError {
  response?: { data?: { error?: string } };
  message?: string;
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as ApiError;
  return e?.response?.data?.error || e?.message || fallback;
}

interface EditForm {
  description: string;
  website_url: string;
  phone_number: string;
  delivery_zones: string;
}

const EMPTY_EDIT_FORM: EditForm = {
  description: '',
  website_url: '',
  phone_number: '',
  delivery_zones: '',
};

export default function CaptainListingPanel() {
  const { showToast } = useToast();

  const [status, setStatus] = useState<CaptainListingStatus | null>(null);
  const [suggestions, setSuggestions] = useState<CaptainSuggestion[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [claiming, setClaiming] = useState<boolean>(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(EMPTY_EDIT_FORM);

  // Seed the edit form whenever a linked listing arrives (or changes
  // identity after a claim). These fields are top-level on the listing
  // doc (set by POST /cities/:slug/listings and updated via PATCH) —
  // not inside `tags`, which is reserved for the curated taxonomy bag
  // (cuisine_primary, price_band, etc.).
  useEffect(() => {
    if (status?.linked && status.listing) {
      const l = status.listing;
      setEditForm({
        description: l.description ?? '',
        website_url: l.website_url ?? '',
        phone_number: l.phone_number ?? '',
        delivery_zones: (l.delivery_zones ?? []).join('\n'),
      });
    } else {
      setEditForm(EMPTY_EDIT_FORM);
    }
  }, [status]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getCaptainListing();
      setStatus(next);
      if (!next.linked) {
        try {
          const suggested = await getCaptainSuggestedListings();
          setSuggestions(suggested);
        } catch (suggestErr: unknown) {
          // Suggestions are best-effort; surface a soft error but still
          // let the unlinked-state UI render (with an empty list).
          setSuggestions([]);
          setError(errorMessage(suggestErr, 'Could not load suggestions'));
        }
      } else {
        setSuggestions([]);
      }
    } catch (err: unknown) {
      setError(errorMessage(err, 'Could not load captain listing'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleClaim = useCallback(
    async (listingId: string) => {
      if (claiming) return;
      setClaiming(true);
      setClaimingId(listingId);
      try {
        await claimCaptainListing(listingId);
        showToast('Listing claimed!', 'success');
        await loadAll();
      } catch (err: unknown) {
        // Backend returns 409 when the listing is already claimed by
        // someone else; surface the server message so the merchant sees
        // exactly why their pick failed.
        showToast(errorMessage(err, 'Could not claim listing'), 'error');
      } finally {
        setClaiming(false);
        setClaimingId(null);
      }
    },
    [claiming, loadAll, showToast],
  );

  // Only emit the delivery_zones field for cloud-kitchen listings.
  // Physical restaurants don't define service zones at this layer, so
  // including the field would noisily overwrite the merchant's empty
  // textarea over their tags.delivery_zones on every save.
  const isCloudKitchen = useMemo(() => {
    return status?.linked && status.listing?.business_type === 'cloud_kitchen';
  }, [status]);

  const handleSave = useCallback(async () => {
    if (!status?.linked) return;
    setSaving(true);
    try {
      const body: CaptainListingUpdate = {
        description: editForm.description.trim() || null,
        website_url: editForm.website_url.trim() || null,
        phone_number: editForm.phone_number.trim() || null,
      };
      if (isCloudKitchen) {
        body.delivery_zones = editForm.delivery_zones
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      await updateCaptainListing(body);
      showToast('Saved', 'success');
      await loadAll();
    } catch (err: unknown) {
      showToast(errorMessage(err, 'Save failed'), 'error');
    } finally {
      setSaving(false);
    }
  }, [editForm, isCloudKitchen, loadAll, showToast, status]);

  return (
    <div id="tab-captain-listing">
      <div className="mb-4">
        <h2 className="m-0">Captain Listing</h2>
        <div className="text-sm text-dim mt-1">
          Manage how GullyBite&apos;s city captain surfaces you to nearby customers.
        </div>
      </div>

      {loading ? (
        <div className="card">
          <div className="cb text-sm text-dim">Loading…</div>
        </div>
      ) : error && !status ? (
        <div className="notice warn">{error}</div>
      ) : status?.linked === false ? (
        <UnlinkedState
          suggestions={suggestions}
          claiming={claiming}
          claimingId={claimingId}
          onClaim={handleClaim}
        />
      ) : status?.linked === true ? (
        <LinkedState
          status={status}
          editForm={editForm}
          isCloudKitchen={Boolean(isCloudKitchen)}
          saving={saving}
          onChange={setEditForm}
          onSave={handleSave}
        />
      ) : null}
    </div>
  );
}

interface UnlinkedStateProps {
  suggestions: CaptainSuggestion[];
  claiming: boolean;
  claimingId: string | null;
  onClaim: (listingId: string) => void;
}

function UnlinkedState({ suggestions, claiming, claimingId, onClaim }: UnlinkedStateProps) {
  return (
    <>
      <div className="notice">
        Customers discover you via GullyBite&apos;s city captain. Claim your listing to
        activate demand and let waiting customers know you&apos;re live.
      </div>

      <div className="card">
        <div className="ch">
          <h3 className="m-0">Your listing on GullyBite</h3>
        </div>
        <div className="cb">
          {suggestions.length === 0 ? (
            <div className="text-sm text-dim">
              No matching listings found. Contact support to get your restaurant listed.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {suggestions.map((l) => (
                <SuggestionRow
                  key={l.id}
                  listing={l}
                  claiming={claiming}
                  claimingId={claimingId}
                  onClaim={onClaim}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

interface SuggestionRowProps {
  listing: CaptainSuggestion;
  claiming: boolean;
  claimingId: string | null;
  onClaim: (listingId: string) => void;
}

function SuggestionRow({ listing, claiming, claimingId, onClaim }: SuggestionRowProps) {
  const isClaimingThis = claiming && claimingId === listing.id;
  const cityLabel = listing.city?.name || '—';
  return (
    <div className="flex items-center gap-3 border border-rim rounded-r py-3 px-3 bg-panel">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <strong className="text-base">{listing.name}</strong>
          {listing.unfulfilled_notify_count > 0 && (
            <span className="chip on text-xs">
              {listing.unfulfilled_notify_count} customers waiting
            </span>
          )}
        </div>
        <div className="text-xs text-dim mt-1">
          {listing.area} · {cityLabel}
        </div>
      </div>
      <button
        type="button"
        className="btn-g"
        disabled={isClaimingThis}
        onClick={() => onClaim(listing.id)}
      >
        {isClaimingThis ? 'Claiming…' : 'This is us — Claim'}
      </button>
    </div>
  );
}

interface LinkedStateProps {
  status: CaptainListingStatus;
  editForm: EditForm;
  isCloudKitchen: boolean;
  saving: boolean;
  onChange: (next: EditForm) => void;
  onSave: () => void;
}

function LinkedState({ status, editForm, isCloudKitchen, saving, onChange, onSave }: LinkedStateProps) {
  const listing = status.listing;
  if (!listing) return null;
  const cityLabel = status.city?.name || '—';
  const statusBadgeClass =
    listing.status === 'active'
      ? 'chip on'
      : listing.status === 'draft'
        ? 'chip text-yellow-600'
        : 'chip';
  // fulfillment_mode is one of 'notify_only' | 'handoff'. The spec
  // pins the handoff label to "Handoff — active". For notify_only we
  // surface a neutral "Notify only" pill so the merchant can tell the
  // surface state at a glance.
  const handoffActive = listing.fulfillment_mode === 'handoff';

  return (
    <>
      <div className="card">
        <div className="cb">
          <h1 className="text-2xl font-bold m-0">{listing.name}</h1>
          <div className="text-sm text-dim mt-1">
            {listing.area} · {cityLabel}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={statusBadgeClass}>{listing.status}</span>
            {handoffActive ? (
              <span className="chip on">Handoff — active</span>
            ) : (
              <span className="chip">Notify only</span>
            )}
          </div>
        </div>
      </div>

      <NotifyCallout counts={status.notify_counts} />

      <div className="card">
        <div className="ch">
          <h3 className="m-0">Edit listing</h3>
        </div>
        <div className="cb flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-dim">Description</span>
            <textarea
              className="inp"
              rows={4}
              value={editForm.description}
              onChange={(ev) => onChange({ ...editForm, description: ev.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-dim">Website URL</span>
            <input
              className="inp"
              type="url"
              placeholder="https://"
              value={editForm.website_url}
              onChange={(ev) => onChange({ ...editForm, website_url: ev.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-dim">Phone number</span>
            <input
              className="inp"
              type="tel"
              value={editForm.phone_number}
              onChange={(ev) => onChange({ ...editForm, phone_number: ev.target.value })}
            />
          </label>
          {isCloudKitchen && (
            <label className="flex flex-col gap-1">
              <span className="text-sm text-dim">Delivery zones (one zone per line)</span>
              <textarea
                className="inp"
                rows={4}
                value={editForm.delivery_zones}
                onChange={(ev) => onChange({ ...editForm, delivery_zones: ev.target.value })}
              />
            </label>
          )}
          <div className="flex justify-end">
            <button type="button" className="btn-g" disabled={saving} onClick={onSave}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Notify-counts callout — drives the "X customers are waiting" cue.
// Unfulfilled has the warn modifier because it's an action prompt
// (customers waiting); the fulfilled-only case is informational so it
// uses the plain notice. Returns null when there's nothing to say.
function NotifyCallout({ counts }: { counts?: { total: number; unfulfilled: number; fulfilled: number } }) {
  if (!counts) return null;
  if (counts.unfulfilled > 0) {
    return (
      <div className="notice warn">
        {counts.unfulfilled} customers are waiting to hear from you — they&apos;ve been sent your GullyBite link automatically.
      </div>
    );
  }
  if (counts.fulfilled > 0) {
    return (
      <div className="notice">
        {counts.fulfilled} customers were notified when you joined. No pending notifications.
      </div>
    );
  }
  return null;
}
