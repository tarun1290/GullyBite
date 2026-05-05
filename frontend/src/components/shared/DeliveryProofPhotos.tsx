'use client';

// Shared 3PL proof-photo display.
//
// Backend persists `prorouting_pickup_proof` (rider-arrived-at-pickup
// photo) and `prorouting_delivery_proof` (doorstep handover photo) URLs
// on the order doc when the Prorouting status callbacks for those events
// arrive (see backend/src/routes/webhookProrouting.js). This component
// renders them as labelled thumbnails. Click → open full-size in a new
// tab.
//
// Used by:
//   • frontend/src/components/restaurant/OrderDetailModal.tsx (restaurant)
//   • frontend/src/app/admin/orders/page.tsx (admin orders table)
//
// Style note: codebase uses inline `style={{...}}` rather than Tailwind
// classes for component-local styling — this component matches that
// convention so it slots into either surface without requiring tailwind
// class import paths.

interface DeliveryProofPhotosProps {
  pickupProof?: string;
  deliveryProof?: string;
  // Thumbnail edge length in px. Modal default = 120 (readable photo
  // detail). Pass ~64 for compact use inside dense tables.
  size?: number;
  // Layout direction. 'horizontal' = side-by-side (modal), 'vertical' =
  // stacked (table cells with limited width).
  layout?: 'horizontal' | 'vertical';
}

export default function DeliveryProofPhotos({
  pickupProof,
  deliveryProof,
  size = 120,
  layout = 'horizontal',
}: DeliveryProofPhotosProps) {
  const pickup = typeof pickupProof === 'string' && pickupProof.trim()
    ? pickupProof.trim()
    : null;
  const delivery = typeof deliveryProof === 'string' && deliveryProof.trim()
    ? deliveryProof.trim()
    : null;
  if (!pickup && !delivery) return null;

  const labelStyle = { fontSize: '.72rem', color: 'var(--dim)' as const };
  const imgStyle = {
    width: size,
    height: size,
    objectFit: 'cover' as const,
    borderRadius: 8,
    border: '1px solid var(--rim2)',
    display: 'block' as const,
  };
  const containerStyle = {
    display: 'flex',
    flexDirection: layout === 'vertical' ? ('column' as const) : ('row' as const),
    gap: '.6rem',
    flexWrap: 'wrap' as const,
  };

  return (
    <div style={containerStyle}>
      {pickup && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <div style={labelStyle}>Pickup Proof</div>
          <a href={pickup} target="_blank" rel="noreferrer" title="Open full size">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pickup} alt="Pickup proof" style={imgStyle} />
          </a>
        </div>
      )}
      {delivery && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
          <div style={labelStyle}>Delivery Proof</div>
          <a href={delivery} target="_blank" rel="noreferrer" title="Open full size">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={delivery} alt="Delivery proof" style={imgStyle} />
          </a>
        </div>
      )}
    </div>
  );
}
