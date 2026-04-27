// Offline fallback for the PWA. Served from cache by sw.js when a
// navigation request fails (no network). No data fetching, no interactive
// state — must work even when nothing else does.

export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        background: '#FAF8F3',
        color: '#1c1c1c',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div
        className="card"
        style={{
          maxWidth: 420,
          width: '100%',
          padding: '2rem 1.5rem',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '2.4rem', marginBottom: '.6rem' }}>📡</div>
        <h1 style={{ fontSize: '1.2rem', margin: '0 0 .4rem' }}>You&rsquo;re offline</h1>
        <p style={{ fontSize: '.9rem', color: '#5b5b5b', margin: 0 }}>
          Please check your connection and try again.
        </p>
      </div>
    </div>
  );
}
