function Icon({ path }) {
  return (
    <svg
      className="landing-features-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}

const FEATURES = [
  {
    title: 'WhatsApp catalog & cart',
    body: 'Native Meta product catalog per branch. Customers browse, add to cart and check out inside the WhatsApp thread.',
    path: (
      <>
        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
        <line x1="3" y1="6" x2="21" y2="6" />
        <path d="M16 10a4 4 0 0 1-8 0" />
      </>
    ),
  },
  {
    title: 'Razorpay payments',
    body: 'UPI, cards, net banking, wallets. Payment links auto-sent inside WhatsApp; refunds and settlements handled for you.',
    path: (
      <>
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <line x1="2" y1="10" x2="22" y2="10" />
      </>
    ),
  },
  {
    title: 'Customer ownership',
    body: 'Every phone number is yours. Tag customers, segment by frequency, and run campaigns on a list nobody can revoke.',
    path: (
      <>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
  },
  {
    title: 'Campaigns & broadcasts',
    body: 'Send approved template messages to segmented lists. Announce new dishes, reward loyalty, win back lapsed orderers.',
    path: (
      <>
        <path d="M3 11l18-8v18L3 13Z" />
        <path d="M7 15v4a2 2 0 0 0 4 0v-3" />
      </>
    ),
  },
  {
    title: 'Coupons & loyalty',
    body: 'Percent or flat discounts with usage caps, expiry and minimum-order rules. Loyalty points redeemable at checkout.',
    path: (
      <>
        <path d="M20.59 13.41 13.41 20.6a2 2 0 0 1-2.82 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
        <line x1="7" y1="7" x2="7" y2="7.01" />
      </>
    ),
  },
  {
    title: 'Multi-branch ready',
    body: 'Location-aware routing — customer shares GPS, the nearest branch catalog shows up. Onboard new outlets in minutes.',
    path: (
      <>
        <path d="M3 21V7l9-4 9 4v14" />
        <path d="M9 21V11h6v10" />
      </>
    ),
  },
  {
    title: 'Logistics integrations',
    body: 'Plug in Dunzo, Porter or Shadowfax at checkout, or run your own fleet — delivery fee shown to the customer in-thread.',
    path: (
      <>
        <path d="M22 16.92V19a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 3.18 2 2 0 0 1 4.11 1h2a2 2 0 0 1 2 1.72c.12.81.33 1.6.63 2.34a2 2 0 0 1-.45 2.11L7.09 8.36a16 16 0 0 0 6 6l1.19-1.19a2 2 0 0 1 2.11-.45c.74.3 1.53.51 2.34.63A2 2 0 0 1 22 16.92Z" />
      </>
    ),
  },
  {
    title: 'Settlements & reports',
    body: 'Weekly auto-payouts to your bank. Itemised ledger, GST-ready reports, and analytics on revenue, repeats and top items.',
    path: (
      <>
        <path d="M20 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8Z" />
        <path d="M14 2v6h6" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="13" y2="17" />
      </>
    ),
  },
];

export default function SectionFeatures() {
  return (
    <section className="landing-features" id="features">
      <div className="landing-features-inner">
        <div className="landing-features-head">
          <div className="landing-features-eyebrow">Features</div>
          <h2 className="landing-features-headline">
            Everything you need.
            <br />
            Nothing you don&rsquo;t.
          </h2>
        </div>

        <div className="landing-features-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="landing-features-tile">
              <Icon path={f.path} />
              <h3 className="landing-features-tile-title">{f.title}</h3>
              <p className="landing-features-tile-body">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
