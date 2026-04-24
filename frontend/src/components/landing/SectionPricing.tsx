'use client';

const FEATURES = [
  'Unlimited orders — zero commission',
  'Up to 5 branches and catalog locations',
  'Unlimited menu items with instant sync',
  'WhatsApp ordering, cart and checkout',
  'Razorpay payment collection built-in',
  'Coupons, discounts and loyalty points',
  'Message template automation',
  'Real-time dashboard and analytics',
  'Weekly automated bank settlements',
];

function Check() {
  return (
    <svg
      className="landing-pricing-check"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M5 12l5 5 9-11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface SectionPricingProps {
  onGetStarted?: () => void;
}

export default function SectionPricing({ onGetStarted }: SectionPricingProps) {
  return (
    <section className="landing-pricing" id="pricing">
      <div className="landing-pricing-inner">
        <div className="landing-pricing-head">
          <div className="landing-pricing-eyebrow">Pricing</div>
          <h2 className="landing-pricing-headline">One plan. No surprises.</h2>
          <p className="landing-pricing-sub">
            A flat monthly subscription. Keep what you earn instead of handing a quarter to a
            platform.
          </p>
        </div>

        <div className="landing-pricing-card">
          <div className="landing-pricing-plan">Restaurant plan</div>
          <div className="landing-pricing-price">
            <span className="landing-pricing-amount">&#8377;2,999</span>
            <span className="landing-pricing-period">/month</span>
          </div>
          <div className="landing-pricing-meta">+ &#8377;5&ndash;10 per order processed</div>

          <ul className="landing-pricing-list">
            {FEATURES.map((f) => (
              <li key={f} className="landing-pricing-list-item">
                <Check />
                <span>{f}</span>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="landing-btn-primary landing-btn-lg landing-pricing-cta"
            onClick={onGetStarted}
          >
            Start 14-Day Free Trial
          </button>
          <div className="landing-pricing-note">No credit card required.</div>
        </div>

        <p className="landing-pricing-anchor">
          Compare that to <strong>25&ndash;30%</strong> of every order on aggregators. The first
          ~12 orders a month pay for GullyBite; everything after goes to you.
        </p>
      </div>
    </section>
  );
}
