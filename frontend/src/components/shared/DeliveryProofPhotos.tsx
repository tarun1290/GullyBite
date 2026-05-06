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

  // width/height stay inline — `size` is a runtime prop and Tailwind
  // arbitrary values must be statically analyzable at build time.
  const imgSize = { width: size, height: size };

  return (
    <div
      className={`flex gap-[0.6rem] flex-wrap ${layout === 'vertical' ? 'flex-col' : 'flex-row'}`}
    >
      {pickup && (
        <div className="flex flex-col gap-1">
          <div className="text-[0.72rem] text-dim">Pickup Proof</div>
          <a href={pickup} target="_blank" rel="noreferrer" title="Open full size">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pickup}
              alt="Pickup proof"
              style={imgSize}
              className="object-cover rounded-lg border border-rim2 block"
            />
          </a>
        </div>
      )}
      {delivery && (
        <div className="flex flex-col gap-1">
          <div className="text-[0.72rem] text-dim">Delivery Proof</div>
          <a href={delivery} target="_blank" rel="noreferrer" title="Open full size">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={delivery}
              alt="Delivery proof"
              style={imgSize}
              className="object-cover rounded-lg border border-rim2 block"
            />
          </a>
        </div>
      )}
    </div>
  );
}
