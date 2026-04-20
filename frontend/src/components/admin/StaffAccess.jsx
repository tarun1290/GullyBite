import { useEffect, useState } from 'react';
import { useToast } from '../Toast.jsx';
import {
  getRestaurantStaffPinStatus,
  generateRestaurantStaffPin,
} from '../../api/admin.js';

// Renders the three UI states described in the Staff PIN spec:
//   1. No PIN yet → call-to-action to generate
//   2. Just generated → four digit boxes + amber warning + copyable slug
//   3. PIN exists but not just generated → last-generated date + slug + regenerate
//
// Backend shape: GET  /api/admin/restaurants/:id/staff-pin/status returns
// { success, has_pin, staff_pin_updated_at }. POST /staff-pin/generate returns
// { success, pin, staff_pin_updated_at } — the plain PIN is shown once and
// cleared on unmount so returning to the page hides it.

export default function StaffAccess({ restaurantId, slug }) {
  const { showToast } = useToast();
  const [pinStatus, setPinStatus] = useState(null);
  const [generatedPin, setGeneratedPin] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshStatus = async () => {
    try {
      const data = await getRestaurantStaffPinStatus(restaurantId);
      setPinStatus({
        exists: !!(data?.has_pin ?? data?.exists),
        generated_at: data?.staff_pin_updated_at ?? data?.generated_at ?? null,
      });
      setLoadErr(null);
    } catch (err) {
      setLoadErr(err?.response?.data?.error || err.message || 'Failed to load PIN status');
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { await refreshStatus(); } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Never leave the plain PIN in memory across mounts.
      setGeneratedPin(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const data = await generateRestaurantStaffPin(restaurantId);
      const pin = String(data?.pin || '');
      if (!pin) throw new Error('No PIN returned from server');
      setGeneratedPin(pin);
      showToast('Staff PIN generated', 'success');
      await refreshStatus();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Generate failed', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = async (text, label = 'Copied') => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label, 'success');
    } catch {
      showToast('Copy failed — please copy manually', 'error');
    }
  };

  const formattedDate = pinStatus?.generated_at
    ? new Date(pinStatus.generated_at).toLocaleString()
    : null;

  return (
    <section className="card" style={{ marginTop: '1.2rem' }}>
      <div className="ch">
        <h3>🔐 Staff Access</h3>
      </div>
      <div className="cb" style={{ display: 'flex', flexDirection: 'column', gap: '.9rem' }}>
        {loading ? (
          <p style={{ color: 'var(--dim)', fontSize: '.82rem' }}>Loading PIN status…</p>
        ) : loadErr ? (
          <p style={{ color: 'var(--red)', fontSize: '.82rem' }}>{loadErr}</p>
        ) : generatedPin ? (
          <JustGeneratedView
            pin={generatedPin}
            slug={slug}
            onCopy={handleCopy}
            onRegenerate={handleGenerate}
            isGenerating={isGenerating}
          />
        ) : pinStatus?.exists ? (
          <ExistingPinView
            generatedAt={formattedDate}
            slug={slug}
            onCopy={handleCopy}
            onRegenerate={handleGenerate}
            isGenerating={isGenerating}
          />
        ) : (
          <NoPinView onGenerate={handleGenerate} isGenerating={isGenerating} />
        )}
      </div>
    </section>
  );
}

function NoPinView({ onGenerate, isGenerating }) {
  return (
    <>
      <p style={{ color: 'var(--dim)', fontSize: '.85rem', lineHeight: 1.5 }}>
        No staff PIN set. Generate one to give your kitchen staff access to the GullyBite Staff app.
      </p>
      <div>
        <button
          type="button"
          className="btn-p"
          onClick={onGenerate}
          disabled={isGenerating}
          aria-busy={isGenerating}
        >
          {isGenerating ? (
            <>
              <span className="spin" aria-hidden />
              <span style={{ marginLeft: '.5rem' }}>Generating…</span>
            </>
          ) : (
            'Generate Staff PIN'
          )}
        </button>
      </div>
    </>
  );
}

function JustGeneratedView({ pin, slug, onCopy, onRegenerate, isGenerating }) {
  const digits = pin.padEnd(4, '•').split('').slice(0, Math.max(4, pin.length));
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '.5rem' }} aria-label="Generated staff PIN">
          {digits.map((d, i) => (
            <span
              key={i}
              style={{
                width: 52, height: 60, display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center',
                background: '#fff', border: '1px solid var(--rim)', borderRadius: 10,
                fontFamily: 'monospace', fontSize: '1.75rem', fontWeight: 800, color: 'var(--tx)',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              {d}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="btn-g"
          onClick={() => onCopy(pin, 'PIN copied')}
          aria-label="Copy PIN"
          title="Copy PIN"
          style={{ minHeight: 44 }}
        >
          📋 Copy
        </button>
      </div>
      <div
        role="alert"
        style={{
          background: '#fffbeb', border: '1px solid #fcd34d',
          borderRadius: 8, padding: '.7rem .9rem',
          color: '#92400e', fontSize: '.82rem', fontWeight: 600, lineHeight: 1.45,
        }}
      >
        ⚠ Save this PIN now — it will not be shown again once you leave this page.
      </div>
      <SlugField slug={slug} onCopy={onCopy} />
      <div>
        <button type="button" className="btn-g" onClick={onRegenerate} disabled={isGenerating}>
          {isGenerating ? 'Regenerating…' : 'Regenerate PIN'}
        </button>
      </div>
    </>
  );
}

function ExistingPinView({ generatedAt, slug, onCopy, onRegenerate, isGenerating }) {
  return (
    <>
      <p style={{ color: 'var(--tx)', fontSize: '.88rem' }}>
        Staff PIN last generated on{' '}
        <strong>{generatedAt || 'an earlier date'}</strong>.
      </p>
      <SlugField slug={slug} onCopy={onCopy} />
      <div>
        <button type="button" className="btn-g" onClick={onRegenerate} disabled={isGenerating}>
          {isGenerating ? (
            <>
              <span className="spin" aria-hidden />
              <span style={{ marginLeft: '.5rem' }}>Regenerating…</span>
            </>
          ) : (
            'Regenerate PIN'
          )}
        </button>
      </div>
    </>
  );
}

function SlugField({ slug, onCopy }) {
  const value = slug || '';
  return (
    <div>
      <label className="lbl" htmlFor="staff-login-slug">Staff app login slug</label>
      <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
        <input
          id="staff-login-slug"
          type="text"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          style={{ flex: 1, fontFamily: 'monospace' }}
          placeholder={value ? '' : 'Slug unavailable'}
        />
        <button
          type="button"
          className="btn-g"
          onClick={() => onCopy(value, 'Slug copied')}
          disabled={!value}
          aria-label="Copy slug"
          title="Copy slug"
          style={{ minHeight: 44 }}
        >
          📋 Copy
        </button>
      </div>
    </div>
  );
}
