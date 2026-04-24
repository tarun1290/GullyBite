'use client';

import { useState } from 'react';

const EXPLAINERS = [
  {
    key: 'ads',
    title: 'Auto-enabled ads',
    body: "New listings are auto-opted into pay-to-play ranking. Opting out drops your visibility to near zero, so 'advertising' becomes the cost of being seen at all.",
  },
  {
    key: 'discounts',
    title: 'Forced discounts',
    body: "Flash sales, dining programs and 'restaurant-funded' promos are effectively mandatory for relevance. The discount comes out of your payout, not the platform's.",
  },
  {
    key: 'invisible',
    title: 'Invisible customer',
    body: 'You never see the customer phone number, delivery address history, or order frequency. The relationship belongs to the platform — not to you.',
  },
];

export default function SectionProblem() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggle = (k: string) => setOpenKey((cur) => (cur === k ? null : k));

  return (
    <section className="landing-problem" id="problem">
      <div className="landing-problem-inner">
        <div className="landing-problem-head">
          <div className="landing-problem-eyebrow">The problem</div>
          <h2 className="landing-problem-headline">
            Restaurants lose <span className="landing-problem-percent">53%</span> of every
            &#8377;500 order to aggregator deductions.
          </h2>
          <p className="landing-problem-sub">
            The commission cut you see is just the surface. Hidden ad spend, forced discounts and
            a customer you never meet eat the rest.
          </p>
        </div>

        <div className="landing-problem-cards">
          <div className="landing-problem-payout">
            <div className="landing-problem-payout-label">What you expect</div>
            <div className="landing-problem-payout-rows">
              <div className="landing-problem-payout-row">
                <span>Order value</span>
                <strong>&#8377;500</strong>
              </div>
              <div className="landing-problem-payout-row is-debit">
                <span>Commission (28%)</span>
                <strong>&minus; &#8377;140</strong>
              </div>
            </div>
            <div className="landing-problem-payout-total">
              <span>Net payout</span>
              <strong>&#8377;360</strong>
            </div>
          </div>

          <div className="landing-problem-payout">
            <div className="landing-problem-payout-label">What you actually receive</div>
            <div className="landing-problem-payout-rows">
              <div className="landing-problem-payout-row">
                <span>Order value</span>
                <strong>&#8377;500</strong>
              </div>
              <div className="landing-problem-payout-row is-debit">
                <span>Commission (28%)</span>
                <strong>&minus; &#8377;140</strong>
              </div>
              <div className="landing-problem-payout-row is-debit">
                <span>Ad spend auto-enabled</span>
                <strong>&minus; &#8377;75</strong>
              </div>
              <div className="landing-problem-payout-row is-debit">
                <span>Restaurant-funded discount</span>
                <strong>&minus; &#8377;50</strong>
              </div>
            </div>
            <div className="landing-problem-payout-total is-short">
              <span>Net payout</span>
              <strong>&#8377;235</strong>
            </div>
          </div>
        </div>

        <p className="landing-problem-callout">
          That&rsquo;s <strong>53% of every order</strong> &mdash; gone before it reaches you.
        </p>

        <div className="landing-problem-explainers">
          {EXPLAINERS.map((it) => {
            const open = openKey === it.key;
            return (
              <div
                key={it.key}
                className={`landing-problem-explainer${open ? ' is-open' : ''}`}
              >
                <button
                  type="button"
                  className="landing-problem-explainer-head"
                  onClick={() => toggle(it.key)}
                  aria-expanded={open}
                  aria-controls={`problem-explainer-${it.key}`}
                >
                  <span>{it.title}</span>
                  <span className="landing-problem-explainer-chev" aria-hidden="true">
                    {open ? '−' : '+'}
                  </span>
                </button>
                <div
                  id={`problem-explainer-${it.key}`}
                  className="landing-problem-explainer-body"
                >
                  {it.body}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
