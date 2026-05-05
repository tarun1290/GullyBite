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
    <div
      style={{
        padding: '.6rem .8rem',
        background: '#fef2f2',
        border: '1px solid #fecaca',
        borderRadius: 8,
        color: '#b91c1c',
        fontSize: '.82rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '.6rem',
      }}
    >
      <span>Failed to load: {message}</span>
      {onRetry && (
        <button type="button" className="btn-g btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
