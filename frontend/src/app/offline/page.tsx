// Offline fallback for the PWA. Served from cache by sw.js when a
// navigation request fails (no network). No data fetching, no interactive
// state — must work even when nothing else does.

export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-8 bg-[#FAF8F3] text-[#1c1c1c] font-[system-ui,-apple-system,sans-serif]">
      <div className="card max-w-[420px] w-full py-8 px-6 text-center">
        <div className="text-[2.4rem] mb-[0.6rem]">📡</div>
        <h1 className="text-[1.2rem] mt-0 mb-[0.4rem]">You&rsquo;re offline</h1>
        <p className="text-[0.9rem] text-[#5b5b5b] m-0">
          Please check your connection and try again.
        </p>
      </div>
    </div>
  );
}
