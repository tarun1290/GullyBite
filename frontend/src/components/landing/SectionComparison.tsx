const ROWS = [
  { label: 'Commission per order', them: '25–30% of every order', us: 'Flat monthly fee, zero %' },
  { label: 'Customer ownership', them: 'Platform owns every contact', us: 'Every phone number is yours' },
  { label: 'Customer messaging', them: 'Direct contact blocked', us: 'WhatsApp-native, no gatekeeper' },
  { label: 'Visibility', them: 'Pay-to-play ads & ranking', us: 'Your own WhatsApp link' },
  { label: 'Menu control', them: 'Platform UI, approval delays', us: 'Your catalog, instant sync' },
  { label: 'Branding', them: 'Platform-first lockup', us: 'Your brand, your colours' },
  { label: 'Payouts', them: 'T+7 or longer', us: 'Weekly, automated' },
  { label: 'Discounts', them: 'Restaurant-funded, often forced', us: 'Your rules, your rates' },
  { label: 'Data & analytics', them: 'Whatever they choose to show', us: 'Full order ledger, exportable' },
];

function IconX() {
  return (
    <svg className="landing-cmp-glyph landing-cmp-glyph-x" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M6 18L18 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg className="landing-cmp-glyph landing-cmp-glyph-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 12l5 5 9-11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export default function SectionComparison() {
  return (
    <section className="landing-cmp" id="comparison">
      <div className="landing-cmp-inner">
        <div className="landing-cmp-head">
          <div className="landing-cmp-eyebrow">The difference</div>
          <h2 className="landing-cmp-headline">
            On Swiggy, you <span className="landing-cmp-rent">rent</span> your customers.
            <br />
            On GullyBite, you <span className="landing-cmp-own">own</span> them.
          </h2>
        </div>

        <div className="landing-cmp-card">
          <div className="landing-cmp-header-row" role="presentation">
            <div className="landing-cmp-header-label">What you get</div>
            <div className="landing-cmp-header-col landing-cmp-them">Swiggy / Zomato</div>
            <div className="landing-cmp-header-col landing-cmp-us">GullyBite</div>
          </div>

          {ROWS.map((r) => (
            <div key={r.label} className="landing-cmp-row">
              <div className="landing-cmp-label">{r.label}</div>
              <div className="landing-cmp-cell landing-cmp-them">
                <IconX />
                <span>{r.them}</span>
              </div>
              <div className="landing-cmp-cell landing-cmp-us">
                <IconCheck />
                <span>{r.us}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
