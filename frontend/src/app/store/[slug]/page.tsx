import Image from 'next/image';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

interface StoreData {
  business_name: string | null;
  brand_name: string | null;
  city: string | null;
  restaurant_type: 'veg' | 'non_veg' | 'both' | null;
  logo_url: string | null;
  store_url: string | null;
  store_slug: string | null;
  phone: string | null;
  display_name: string;
}

type StoreFetch =
  | { kind: 'ok'; data: StoreData }
  | { kind: 'notFound' };

async function fetchStore(slug: string): Promise<StoreFetch> {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) throw new Error('NEXT_PUBLIC_API_BASE_URL is not set');
  const url = `${base}/api/restaurant/public/store/${encodeURIComponent(slug)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return { kind: 'notFound' };
  if (!res.ok) throw new Error(`Store fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as StoreData;
  if (!data) return { kind: 'notFound' };
  return { kind: 'ok', data };
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  try {
    const result = await fetchStore(slug);
    if (result.kind === 'notFound') {
      return { title: 'Store not found | GullyBite' };
    }
    const name = result.data.display_name;
    const title = `${name} — Order on WhatsApp | GullyBite`;
    const description = `Order from ${name} directly on WhatsApp. No app needed, zero commission.`;
    return {
      title,
      description,
      openGraph: { title, description, type: 'website' },
    };
  } catch {
    return { title: 'GullyBite' };
  }
}

const TYPE_BADGE: Record<NonNullable<StoreData['restaurant_type']>, { bg: string; fg: string; label: string }> = {
  veg:     { bg: '#dcfce7', fg: '#15803d', label: 'Pure Veg' },
  non_veg: { bg: '#fee2e2', fg: '#b91c1c', label: 'Non-Veg' },
  both:    { bg: '#e0e7ff', fg: '#4338ca', label: 'Veg & Non-Veg' },
};

function waOrderHref(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent('Hi, I want to order')}`;
}

export default async function StorePage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const result = await fetchStore(slug);
  if (result.kind === 'notFound') notFound();

  const r = result.data;
  const badge = r.restaurant_type ? TYPE_BADGE[r.restaurant_type] : TYPE_BADGE.both;
  const phone = r.phone || '';

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#f8fafc',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem 1rem',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#0f172a',
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: '1rem',
          padding: '2.5rem 2rem',
          textAlign: 'center',
          maxWidth: 420,
          width: '100%',
          boxShadow: '0 4px 24px rgba(0,0,0,.08)',
        }}
      >
        {r.logo_url ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
            <Image
              src={r.logo_url}
              alt={`${r.display_name} logo`}
              width={88}
              height={88}
              style={{ borderRadius: 14, objectFit: 'cover' }}
              unoptimized={r.logo_url.startsWith('data:')}
            />
          </div>
        ) : (
          <div
            aria-hidden="true"
            style={{
              width: 88,
              height: 88,
              borderRadius: 14,
              background: '#f1f5f9',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '2.4rem',
              margin: '0 auto 1rem',
            }}
          >
            🍽️
          </div>
        )}

        <h1 style={{ fontSize: '1.6rem', fontWeight: 700, margin: 0, marginBottom: '.4rem' }}>
          {r.display_name}
        </h1>

        {r.city && (
          <p style={{ color: '#64748b', fontSize: '.95rem', margin: 0, marginBottom: '.7rem' }}>
            📍 {r.city}
          </p>
        )}

        <span
          style={{
            display: 'inline-block',
            padding: '.25rem .8rem',
            borderRadius: 999,
            fontSize: '.75rem',
            fontWeight: 600,
            background: badge.bg,
            color: badge.fg,
            marginBottom: '1.4rem',
          }}
        >
          {badge.label}
        </span>

        <p style={{ color: '#64748b', fontSize: '.95rem', margin: 0, marginBottom: '1.4rem', lineHeight: 1.5 }}>
          Order directly on WhatsApp — fast, simple, and no app needed.
        </p>

        {phone ? (
          <a
            href={waOrderHref(phone)}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '.5rem',
              background: '#16a34a',
              color: '#fff',
              fontWeight: 600,
              fontSize: '.95rem',
              padding: '.85rem 1.4rem',
              borderRadius: 10,
              textDecoration: 'none',
              width: '100%',
              boxSizing: 'border-box',
              boxShadow: '0 2px 8px rgba(22,163,74,.3)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" />
            </svg>
            Order on WhatsApp
          </a>
        ) : (
          <button
            type="button"
            disabled
            style={{
              background: '#e2e8f0',
              color: '#64748b',
              fontWeight: 600,
              fontSize: '.95rem',
              padding: '.85rem 1.4rem',
              borderRadius: 10,
              border: 'none',
              width: '100%',
              cursor: 'not-allowed',
            }}
          >
            Coming soon
          </button>
        )}

        <p style={{ marginTop: '1.6rem', fontSize: '.72rem', color: '#94a3b8' }}>
          Powered by GullyBite
        </p>
      </div>
    </main>
  );
}
