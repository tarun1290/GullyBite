const STEPS = [
  { n: '1', h: 'Sign up',          p: 'Create your GullyBite account in under a minute. No setup fee, no sales call required.' },
  { n: '2', h: 'Connect WhatsApp', p: 'One-click Meta login links your WhatsApp Business number and auto-creates your catalog.' },
  { n: '3', h: 'Upload menu',      p: 'Import items in bulk or add them manually. Toggle availability and pricing in seconds.' },
  { n: '4', h: 'Go live',          p: 'Share your WhatsApp link on Instagram, bill prints and Google listing — orders hit your dashboard live.' },
];

export default function SectionHowItWorks() {
  return (
    <section className="landing-hiw" id="how-it-works">
      <div className="landing-hiw-inner">
        <div className="landing-hiw-head">
          <div className="landing-hiw-eyebrow">How it works</div>
          <h2 className="landing-hiw-headline">Live in 24 hours. Not 24 weeks.</h2>
          <p className="landing-hiw-sub">
            Four simple steps to move from aggregator dependency to direct WhatsApp ordering.
          </p>
        </div>

        <ol className="landing-hiw-steps">
          {STEPS.map((s) => (
            <li key={s.n} className="landing-hiw-step">
              <div className="landing-hiw-circle" aria-hidden="true">{s.n}</div>
              <h3 className="landing-hiw-step-title">{s.h}</h3>
              <p className="landing-hiw-step-body">{s.p}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
