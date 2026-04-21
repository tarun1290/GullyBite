import { GULLYBITE_CITY } from '../../config/contact.js';
import { waLink } from '../../utils/whatsapp.js';

export default function SectionFinalCta({ onGetStarted }) {
  const msg = `Hi, I run a restaurant in ${GULLYBITE_CITY} and want to learn more about GullyBite.`;

  return (
    <section className="landing-finalcta">
      <div className="landing-finalcta-inner">
        <h2 className="landing-finalcta-headline">
          You built the kitchen.
          <br />
          <span className="landing-finalcta-middle">They took the customer.</span>
          <br />
          <span className="landing-finalcta-last">Take it back.</span>
        </h2>

        <p className="landing-finalcta-sub">
          Switch from aggregator dependency to direct WhatsApp ordering in 24 hours. First 14
          days free, no credit card, cancel in one click.
        </p>

        <div className="landing-finalcta-ctas">
          <button
            type="button"
            className="landing-btn-primary landing-btn-lg"
            onClick={onGetStarted}
          >
            Get Started Free &rarr;
          </button>
          <a
            className="landing-btn-ghost landing-btn-lg landing-finalcta-ghost"
            href={waLink(msg)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Talk on WhatsApp
          </a>
        </div>
      </div>
    </section>
  );
}
