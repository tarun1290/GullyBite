const BLOCKS = [
  {
    num: '01',
    label: 'Own the storefront',
    body: 'Your brand, your menu, your catalog. No platform header, no competitor tiles next to your listing.',
  },
  {
    num: '02',
    label: 'Own the customer',
    body: 'Every phone number belongs to you. Message, re-engage and reward without asking a platform for permission.',
  },
  {
    num: '03',
    label: 'Own the data',
    body: 'Orders, repeat rates and item trends are yours to analyse and act on. Not locked in someone else\u2019s dashboard.',
  },
  {
    num: '04',
    label: 'Own the economics',
    body: 'Flat monthly fee. Zero per-order commission. Every extra order scales your margin, not the platform\u2019s.',
  },
];

export default function SectionPositioning() {
  return (
    <section className="landing-positioning" id="positioning">
      <div className="landing-positioning-inner">
        <div className="landing-positioning-head">
          <div className="landing-positioning-eyebrow">Positioning</div>
          <h2 className="landing-positioning-headline">
            Shopify built commerce for websites.
            <br />
            <span className="landing-positioning-accent">We built it for WhatsApp.</span>
          </h2>
        </div>

        <div className="landing-positioning-grid">
          {BLOCKS.map((b) => (
            <div key={b.num} className="landing-positioning-block">
              <div className="landing-positioning-num">{b.num}</div>
              <div className="landing-positioning-label">{b.label}</div>
              <p className="landing-positioning-body">{b.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
