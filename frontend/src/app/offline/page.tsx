// Offline fallback for the PWA. Served from cache by sw.js when a
// navigation request fails (no network). No data fetching, no interactive
// state — must work even when nothing else does.

export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-8 bg-[#FAF8F3] text-[#1c1c1c] font-[system-ui,-apple-system,sans-serif]">
      <div className="card max-w-[420px] w-full py-8 px-6 text-center">
        <div className="text-[2.4rem] mb-2.5">📡</div>
        <h1 className="text-xl mt-0 mb-1.5">You&rsquo;re offline</h1>
        <p className="text-base text-[#5b5b5b] m-0">
          Please check your connection and try again.
        </p>
      </div>
    </div>
  );
}
