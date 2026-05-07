'use client';

interface SectionErrorProps {
  message: string;
  onRetry?: () => void;
}

// Inline error + retry strip used by every analytics section. Legacy
// silently swallows failures; we surface them so the user knows a section
// is stale.
export default function SectionError({ message, onRetry }: SectionErrorProps) {
  return (
    <div className="py-[0.6rem] px-[0.8rem] bg-[#fef2f2] border border-[#fecaca] rounded-lg text-[#b91c1c] text-[0.82rem] flex justify-between items-center gap-[0.6rem]">
      <span>Failed to load: {message}</span>
      {onRetry && (
        <button type="button" className="btn-g btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
