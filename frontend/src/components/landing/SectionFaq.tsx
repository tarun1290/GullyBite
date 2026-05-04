'use client';

import { useState } from 'react';

const ITEMS = [
  {
    q: 'Do I need a WhatsApp Business API to use GullyBite?',
    a: "Yes, but setup is a one-click Meta login during onboarding. If you don't have an API account yet, we help you set it up in 10 minutes during the signup flow — no paperwork, no agency required.",
  },
  {
    q: 'How does ordering on WhatsApp actually work?',
    a: 'Your customer opens your WhatsApp link or replies to a message. They see your menu as a native Meta product catalog, add items to cart inside the thread, and get a secure Razorpay payment link. No app install, no redirect to a website.',
  },
  {
    q: 'What about deliveries?',
    a: 'GullyBite plugs into delivery partners like Dunzo and Shadowfax (city-dependent) with the delivery fee shown to the customer at checkout. You can also run your own delivery fleet — the choice is yours, and both can coexist.',
  },
  {
    q: 'Is there a per-order commission on top of the monthly fee?',
    a: 'No commission. Ever. You pay ₹2,999/month for up to 5 branches plus ₹5–10 per order processed (payment gateway and messaging cost). Do ₹1L or ₹10L in orders — the platform fee stays flat.',
  },
  {
    q: 'How fast can I actually go live?',
    a: 'Most restaurants go live within 24 hours of signup. Document verification takes a few hours; catalog import and menu configuration is 10 minutes of work on your end. No sales cycle, no implementation consultant.',
  },
  {
    q: 'Can I cancel whenever?',
    a: 'One click in Settings. No lock-in contract, no notice period, no exit fee. Your customer list stays with you on the way out — export it whenever as a CSV.',
  },
];

interface PlusProps {
  open: boolean;
}

function Plus({ open }: PlusProps) {
  return (
    <svg
      className="landing-faq-glyph"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      {!open && (
        <line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      )}
    </svg>
  );
}

export default function SectionFaq() {
  const [openIdx, setOpenIdx] = useState<number>(-1);
  const toggle = (i: number) => setOpenIdx((cur) => (cur === i ? -1 : i));

  return (
    <section className="landing-faq" id="faq">
      <div className="landing-faq-inner">
        <div className="landing-faq-head">
          <div className="landing-faq-eyebrow">FAQ</div>
          <h2 className="landing-faq-headline">Questions you probably still have.</h2>
        </div>

        <div className="landing-faq-list">
          {ITEMS.map((item, i) => {
            const open = openIdx === i;
            return (
              <div
                key={item.q}
                className={`landing-faq-item${open ? ' is-open' : ''}`}
              >
                <button
                  type="button"
                  className="landing-faq-question"
                  onClick={() => toggle(i)}
                  aria-expanded={open}
                  aria-controls={`faq-a-${i}`}
                >
                  <span>{item.q}</span>
                  <Plus open={open} />
                </button>
                <div
                  id={`faq-a-${i}`}
                  className="landing-faq-answer"
                  role="region"
                >
                  {item.a}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
