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
    <div className="py-2.5 px-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm flex justify-between items-center gap-2.5">
      <span>Failed to load: {message}</span>
      {onRetry && (
        <button type="button" className="btn-g btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
