const POINTS = [
  'Customers browse your catalog, build a cart and pay — all inside the WhatsApp thread.',
  'Every phone number is yours. Run promos, loyalty and reorders on a channel you own.',
  'One flat monthly fee. Do ₹1L or ₹10L in orders — your platform cost never changes.',
];

export default function SectionSolution() {
  return (
    <section className="landing-solution" id="solution">
      <div className="landing-solution-inner">
        <div className="landing-solution-head">
          <div className="landing-solution-eyebrow">The solution</div>
          <h2 className="landing-solution-headline">
            WhatsApp becomes your storefront, your checkout and your CRM.
          </h2>
          <p className="landing-solution-sub">
            No app downloads. No redirects. No algorithm gatekeeping between you and the people
            ordering from your kitchen.
          </p>
        </div>

        <div className="landing-solution-video" aria-label="Product demo video">
          <div className="landing-solution-video-card">
            <button
              type="button"
              className="landing-solution-play"
              aria-label="Play product demo"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M8 5v14l11-7z" fill="currentColor" />
              </svg>
            </button>
            <div className="landing-solution-video-label">60-second product demo</div>
          </div>
        </div>

        <ul className="landing-solution-points">
          {POINTS.map((p, i) => (
            <li key={i} className="landing-solution-point">{p}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
