'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useToast } from '../Toast';
import {
  getRestaurantStaffPinStatus,
  generateRestaurantStaffPin,
} from '../../api/admin';

interface StaffPinStatus {
  exists: boolean;
  generated_at: string | null;
}

interface PinStatusResponse {
  has_pin?: boolean;
  exists?: boolean;
  staff_pin_updated_at?: string;
  generated_at?: string;
}

interface PinGenerateResponse {
  pin?: string;
  staff_pin_updated_at?: string;
}

interface StaffAccessProps {
  restaurantId: string;
  slug?: string;
}

export default function StaffAccess({ restaurantId, slug }: StaffAccessProps) {
  const { showToast } = useToast();
  const [pinStatus, setPinStatus] = useState<StaffPinStatus | null>(null);
  const [generatedPin, setGeneratedPin] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refreshStatus = async () => {
    try {
      const data = (await getRestaurantStaffPinStatus(restaurantId)) as PinStatusResponse | null;
      setPinStatus({
        exists: !!(data?.has_pin ?? data?.exists),
        generated_at: data?.staff_pin_updated_at ?? data?.generated_at ?? null,
      });
      setLoadErr(null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setLoadErr(e?.response?.data?.error || e?.message || 'Failed to load PIN status');
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
      setGeneratedPin(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const data = (await generateRestaurantStaffPin(restaurantId)) as PinGenerateResponse | null;
      const pin = String(data?.pin || '');
      if (!pin) throw new Error('No PIN returned from server');
      setGeneratedPin(pin);
      showToast('Staff PIN generated', 'success');
      await refreshStatus();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Generate failed', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = async (text: string, label: string = 'Copied') => {
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

interface NoPinViewProps { onGenerate: () => void; isGenerating: boolean }

function NoPinView({ onGenerate, isGenerating }: NoPinViewProps): ReactNode {
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

interface JustGeneratedViewProps {
  pin: string;
  slug?: string;
  onCopy: (text: string, label?: string) => void;
  onRegenerate: () => void;
  isGenerating: boolean;
}

function JustGeneratedView({ pin, slug, onCopy, onRegenerate, isGenerating }: JustGeneratedViewProps): ReactNode {
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
                background: 'var(--gb-neutral-0)', border: '1px solid var(--rim)', borderRadius: 10,
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

interface ExistingPinViewProps {
  generatedAt: string | null;
  slug?: string;
  onCopy: (text: string, label?: string) => void;
  onRegenerate: () => void;
  isGenerating: boolean;
}

function ExistingPinView({ generatedAt, slug, onCopy, onRegenerate, isGenerating }: ExistingPinViewProps): ReactNode {
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

interface SlugFieldProps { slug?: string; onCopy: (text: string, label?: string) => void }

function SlugField({ slug, onCopy }: SlugFieldProps): ReactNode {
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
