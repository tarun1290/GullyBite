'use client';

interface LandingHeroProps {
  onGetStarted?: () => void;
  onSeeHowItWorks?: () => void;
}

export default function LandingHero({ onGetStarted, onSeeHowItWorks }: LandingHeroProps) {
  const handleSeeHow = () => {
    if (typeof onSeeHowItWorks === 'function') {
      onSeeHowItWorks();
      return;
    }
    const el = document.getElementById('how-it-works');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <section className="landing-hero" id="top">
      <div className="landing-hero-inner">
        <div className="landing-hero-copy">
          <div className="landing-hero-eyebrow">Shopify for F&amp;B Industry</div>

          <h1 className="landing-hero-headline">
            Don&rsquo;t <span className="landing-hero-rent">RENT</span> your customers.{' '}
            <span className="landing-hero-own">OWN</span> them.
          </h1>

          <p className="landing-hero-sub">
            GullyBite turns WhatsApp into your restaurant&rsquo;s ordering engine. Customers
            browse, order and pay &mdash; right inside WhatsApp. No app to install, no aggregator
            skim, no 25% commission.
          </p>

          <div className="landing-hero-ctas">
            <button
              type="button"
              className="landing-btn-primary landing-btn-lg"
              onClick={onGetStarted}
            >
              Get Started Free &rarr;
            </button>
            <button
              type="button"
              className="landing-btn-ghost landing-btn-lg"
              onClick={handleSeeHow}
            >
              See How It Works
            </button>
          </div>

          <ul className="landing-hero-trust">
            <li>No credit card</li>
            <li>14-day free trial</li>
            <li>Live in 10 minutes</li>
          </ul>
        </div>

        <div className="landing-hero-visual" aria-hidden="true">
          <div className="landing-hero-mock">
            <div className="landing-hero-mock-label">
              Product screenshot
              <span>replace with real WhatsApp chat</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
