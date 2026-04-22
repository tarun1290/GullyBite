// Friendly "under review" state used where a section is gated by the backend
// requireApproved middleware (which returns 403 { error: 'pending_approval' }).
// Mirrors the Coming Soon notice pattern used in LoyaltyTab / CustomersTab so
// the gate reads consistently across the dashboard instead of surfacing the
// raw error code via SectionError.
export default function PendingApprovalNotice({ feature = 'This section' }) {
  return (
    <div className="notice wa">
      <div className="notice-ico">✨</div>
      <div className="notice-body">
        <h4>Under Review</h4>
        <p>
          {feature} will be available once your restaurant application is approved.
          You'll be notified by email as soon as your account is activated.
        </p>
      </div>
    </div>
  );
}

// Helper: true when an error value (string or object) represents the
// pending_approval gate. Accepts the useAnalyticsFetch shape (string) and
// the raw axios error shape (object with .response.data.error).
export function isPendingApproval(err) {
  if (!err) return false;
  if (typeof err === 'string') return err === 'pending_approval';
  return err?.response?.data?.error === 'pending_approval';
}
