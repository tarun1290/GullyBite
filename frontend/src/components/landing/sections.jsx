import { GULLYBITE_EMAIL, GULLYBITE_WA_NUMBER, GULLYBITE_CITY } from '../../config/contact.js';
import { waLink } from '../../utils/whatsapp.js';

function scrollTo(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function Problem() {
  const items = [
    { icon: '💸', title: '25–30% commission', body: 'Swiggy and Zomato quietly skim a quarter of every order — before you even pay rent, salaries or ingredient cost.' },
    { icon: '🔒', title: "You don't own the customer", body: 'No name, no phone, no repeat contact. Every regular is rented from the aggregator, and they can switch you off tomorrow.' },
    { icon: '📉', title: 'Algorithm decides your sales', body: "Pay for ads or disappear. Your ranking, your listing, your visibility — all controlled by a platform you don't own." },
  ];
  return (
    <section className="lsection alt" id="problem">
      <div className="lsection-inner">
        <div className="lsection-head">
          <div className="lsection-pill">The problem</div>
          <h2 className="lsection-title">Aggregators are eating your margin</h2>
          <p className="lsection-sub">Most restaurants in India run on 8–12% net margin. A 25% cut isn't a fee — it's your entire profit.</p>
        </div>
        <div className="problem-grid">
          {items.map((it) => (
            <div key={it.title} className="problem-card">
              <div className="icon">{it.icon}</div>
              <h3>{it.title}</h3>
              <p>{it.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Solution() {
  const items = [
    { h: 'Direct WhatsApp ordering', p: 'Customers browse your menu, build a cart and check out inside WhatsApp. No app, no redirect, no friction.' },
    { h: 'You keep the customer', p: 'Every phone number is yours. Run campaigns, send offers, reward loyalty — all via WhatsApp.' },
    { h: 'Zero commission, ever', p: 'Flat monthly subscription. Do ₹1L or ₹10L in orders — you pay the same predictable fee.' },
    { h: 'Real-time kitchen ops', p: 'Orders flow to your dashboard with status workflow, menu toggles and weekly automated payouts.' },
  ];
  return (
    <section className="lsection" id="solution">
      <div className="lsection-inner">
        <div className="lsection-head">
          <div className="lsection-pill">The solution</div>
          <h2 className="lsection-title">WhatsApp-first ordering, built for Indian restaurants</h2>
          <p className="lsection-sub">One platform to take orders, keep customers, and run your kitchen — without handing a cut to anyone.</p>
        </div>
        <div className="solution-grid">
          <div className="solution-list">
            {items.map((it) => (
              <div key={it.h} className="solution-item">
                <div className="check">✓</div>
                <div>
                  <h4>{it.h}</h4>
                  <p>{it.p}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="solution-video" aria-label="Product demo video placeholder">
            {/* Demo video — replace with real Loom embed before launch */}
            60-second demo video<br />
            <em>(Loom embed goes here)</em>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Positioning() {
  return (
    <section className="lsection alt" id="positioning">
      <div className="lsection-inner">
        <div className="lsection-head">
          <div className="lsection-pill">Rent vs. Own</div>
          <h2 className="lsection-title">Stop renting customers from a platform</h2>
          <p className="lsection-sub">Every order on Swiggy or Zomato builds their business, not yours. GullyBite flips that.</p>
        </div>
        <div className="pos-grid">
          <div className="pos-card rent">
            <h3>Renting</h3>
            <h2>Aggregator platforms</h2>
            <ul>
              <li>25–30% cut on every single order</li>
              <li>Customers belong to the platform</li>
              <li>Visibility controlled by algorithm</li>
              <li>Pay more to get seen</li>
              <li>No direct communication allowed</li>
            </ul>
          </div>
          <div className="pos-card own">
            <h3>Owning</h3>
            <h2>GullyBite on WhatsApp</h2>
            <ul>
              <li>Flat ₹2,999/month, zero commission</li>
              <li>Every customer number is yours</li>
              <li>Your brand, your catalog, your rules</li>
              <li>Run campaigns and loyalty you own</li>
              <li>Direct WhatsApp line to every buyer</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export function HowItWorks() {
  const steps = [
    { n: '01', h: 'Sign up & submit details', p: 'Create your account, add business details, FSSAI and bank info. Our team verifies within 1–2 business days.', t: '~5 min' },
    { n: '02', h: 'Connect WhatsApp Business', p: 'One-click Meta login. GullyBite auto-creates a product catalog per branch and wires up the order webhook.', t: '~2 min' },
    { n: '03', h: 'Upload menu & go live', p: 'Bulk-import via CSV or add items manually. Customers start ordering on WhatsApp — orders hit your dashboard live.', t: '~3 min' },
  ];
  return (
    <section className="lsection" id="how-it-works">
      <div className="lsection-inner">
        <div className="lsection-head">
          <div className="lsection-pill">How it works</div>
          <h2 className="lsection-title">From signup to first order in under 10 minutes</h2>
          <p className="lsection-sub">Three steps. No code, no developer, no complicated integrations.</p>
        </div>
        <div className="hiw-grid">
          {steps.map((s) => (
            <div key={s.n} className="hiw-card">
              <div className="hiw-num">{s.n}</div>
              <h3>{s.h}</h3>
              <p>{s.p}</p>
              <div className="hiw-time">⏱ {s.t}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Features() {
  const feats = [
    { icon: '📍', h: 'Location-based routing', p: "Customer shares GPS → nearest branch's menu appears. Multi-city, multi-branch out of the box." },
    { icon: '🛒', h: 'Native WhatsApp checkout', p: 'Browse, cart and pay entirely inside WhatsApp. No app downloads, no browser redirects.' },
    { icon: '⚡', h: 'Auto catalog sync', p: 'Add a branch — Meta product catalog created in seconds. Toggle an item off, it vanishes from WhatsApp instantly.' },
    { icon: '💳', h: 'Razorpay integration', p: 'UPI, cards, net banking, wallets. Payment links auto-sent on WhatsApp; refunds handled automatically.' },
    { icon: '🏷️', h: 'Coupons & offers', p: 'Percent or flat discounts, usage caps, expiry rules, min-order thresholds. Applied during WhatsApp checkout.' },
    { icon: '📩', h: 'Template automation', p: 'Map approved Meta message templates to Confirmed, Preparing, Dispatched, Delivered — variables auto-filled.' },
    { icon: '🎁', h: 'Loyalty points', p: 'Every paid order earns points. Customers redeem directly at checkout. No separate loyalty app needed.' },
    { icon: '📊', h: 'Real-time dashboard', p: 'Live order stream, status workflow, analytics on revenue, top items and customer retention.' },
    { icon: '💰', h: 'Weekly auto-settlements', p: 'Every Monday: gross minus platform fee, transferred to your bank. Itemised breakdown always available.' },
  ];
  return (
    <section className="lsection alt" id="features">
      <div className="lsection-inner">
        <div className="lsection-head">
          <div className="lsection-pill">Platform features</div>
          <h2 className="lsection-title">Everything a modern restaurant needs</h2>
          <p className="lsection-sub">Built specifically for Indian kitchens. No bloat, no per-order cut — just tools that help you sell more.</p>
        </div>
        <div className="lfeats">
          {feats.map((f) => (
            <div key={f.h} className="lfeat">
              <div className="lfeat-icon">{f.icon}</div>
              <h3>{f.h}</h3>
              <p>{f.p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Comparison() {
  const rows = [
    ['Commission per order', '25–30%', '0%'],
    ['Customer ownership', 'Platform owns', 'You own'],
    ['Direct customer messaging', 'Not allowed', 'WhatsApp native'],
    ['Payouts', 'T+7 / weekly', 'Weekly, automated'],
    ['Menu control', 'Platform UI', 'Your catalog, instant sync'],
    ['Visibility', 'Paid ads', 'Your own WhatsApp link'],
    ['Branding', 'Platform-first', 'Your brand only'],
  ];
  return (
    <section className="lsection" id="comparison">
      <div className="lsection-inner">
        <div className="lsection-head">
          <div className="lsection-pill">Side by side</div>
          <h2 className="lsection-title">GullyBite vs. Aggregators</h2>
          <p className="lsection-sub">The real cost of ordering platforms isn't the commission — it's losing the customer.</p>
        </div>
        <div className="cmp-wrap">
          <div className="cmp-row head">
            <div className="cmp-col label">What you get</div>
            <div className="cmp-col">Swiggy / Zomato</div>
            <div className="cmp-col">GullyBite</div>
          </div>
          {rows.map(([label, them, us]) => (
            <div key={label} className="cmp-row">
              <div className="cmp-col label">{label}</div>
              <div className="cmp-col them">{them}</div>
              <div className="cmp-col us">{us}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Pricing({ onSignUp }) {
  return (
    <section className="lsection alt" id="pricing">
      <div className="lsection-inner">
        <div className="lsection-head">
          <div className="lsection-pill">Simple pricing</div>
          <h2 className="lsection-title">One plan. No surprises.</h2>
          <p className="lsection-sub">No per-order commission. No hidden fees. A flat monthly fee so you keep what you earn.</p>
        </div>
        <div className="lprice">
          <div className="lprice-badge">Restaurant Plan</div>
          <div className="lprice-amount">₹2,999<span>/month</span></div>
          <div className="lprice-sub">Billed monthly · Cancel anytime · GST extra</div>
          <ul className="lprice-feats">
            <li>Unlimited orders — zero commission</li>
            <li>Up to 5 branches &amp; locations</li>
            <li>Unlimited menu items with auto-sync</li>
            <li>WhatsApp ordering, cart &amp; checkout</li>
            <li>Razorpay payment collection built-in</li>
            <li>Coupons, discounts &amp; loyalty points</li>
            <li>Message template automation</li>
            <li>Real-time dashboard &amp; analytics</li>
            <li>Weekly automatic bank settlements</li>
            <li>Dedicated onboarding support</li>
          </ul>
          <button type="button" className="lbtn lbtn-primary lbtn-lg" style={{ width: '100%' }} onClick={onSignUp}>
            Start 14-Day Free Trial →
          </button>
          <p className="lprice-note">No credit card required. Cancel anytime in 1 click.</p>
        </div>
      </div>
    </section>
  );
}

export function Faq() {
  const qs = [
    { q: 'Do I need a WhatsApp Business API?', a: 'Yes — but setup is one-click. GullyBite connects to your Meta / WhatsApp Business account and configures everything for you. If you don\'t have one yet, we help you set it up during onboarding.' },
    { q: 'How does WhatsApp ordering actually work?', a: 'Customers open your WhatsApp link, browse your menu (a native Meta product catalog), add items to cart and get a payment link — all inside WhatsApp. No app, no redirect.' },
    { q: 'What about deliveries?', a: 'GullyBite integrates with delivery partners (Dunzo / Porter / Shadowfax, city-dependent) and surfaces shipping cost at checkout. Or run your own delivery fleet — the choice is yours.' },
    { q: 'Is there a per-order fee?', a: 'No. Zero. One flat monthly subscription covers unlimited orders across up to 5 branches. The only variable cost is your payment gateway fee (Razorpay standard rates).' },
    { q: 'How fast can I go live?', a: 'Most restaurants go live within 1–2 business days of signup. Document verification takes a few hours; catalog + menu setup is 10 minutes on your end.' },
    { q: 'Can I cancel anytime?', a: 'Yes. One click in the Settings tab. No lock-in, no notice period, no exit fee. Keep your customer list if you leave — it\'s yours.' },
    { q: 'What if my customers prefer Swiggy?', a: 'Run both. GullyBite replaces nothing — it gives you a direct channel so repeat customers skip the commission and come to you. Most of our restaurants see 30–40% of orders migrate to WhatsApp within 3 months.' },
  ];
  return (
    <section className="lsection" id="faq">
      <div className="lsection-inner">
        <div className="lsection-head">
          <div className="lsection-pill">Questions</div>
          <h2 className="lsection-title">Frequently asked questions</h2>
          <p className="lsection-sub">Couldn't find what you're looking for? WhatsApp us on {GULLYBITE_WA_NUMBER}.</p>
        </div>
        <div className="faq-list">
          {qs.map((item, i) => (
            <details key={i} className="faq-item" open={i === 0}>
              <summary>{item.q}</summary>
              <div className="answer">{item.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FinalCta({ onSignUp }) {
  return (
    <section className="final-cta">
      <h2>Ready to own your orders?</h2>
      <p>Join restaurants across India who've switched from aggregators to direct WhatsApp ordering with GullyBite. First 14 days free, no credit card required.</p>
      <div className="btns">
        <button type="button" className="lbtn lbtn-primary lbtn-lg" onClick={onSignUp}>Get Started Free →</button>
        <a className="lbtn lbtn-ghost lbtn-lg" href={waLink('Hi, I run a restaurant in ' + GULLYBITE_CITY + ' and want to know more about GullyBite')} target="_blank" rel="noreferrer">💬 Talk to us on WhatsApp</a>
      </div>
    </section>
  );
}

export function LandingFooter({ onSignIn, onSignUp }) {
  return (
    <footer className="lfooter">
      <div className="lfooter-inner">
        <div>
          <div className="lfooter-brand">
            <div className="brand-ring">🍜</div>
            GullyBite
          </div>
          <p className="lfooter-about">
            WhatsApp-first ordering for Indian restaurants. Zero commission, weekly payouts, full customer ownership.
          </p>
        </div>
        <div>
          <h4>Product</h4>
          <ul>
            <li><button type="button" onClick={() => scrollTo('how-it-works')}>How it works</button></li>
            <li><button type="button" onClick={() => scrollTo('features')}>Features</button></li>
            <li><button type="button" onClick={() => scrollTo('calculator')}>ROI Calculator</button></li>
            <li><button type="button" onClick={() => scrollTo('pricing')}>Pricing</button></li>
            <li><button type="button" onClick={() => scrollTo('faq')}>FAQ</button></li>
          </ul>
        </div>
        <div>
          <h4>Account</h4>
          <ul>
            <li><button type="button" onClick={onSignUp}>Create account</button></li>
            <li><button type="button" onClick={onSignIn}>Sign in</button></li>
          </ul>
        </div>
        <div>
          <h4>Contact</h4>
          <ul>
            <li><a href={waLink()} target="_blank" rel="noreferrer">WhatsApp {GULLYBITE_WA_NUMBER}</a></li>
            <li><a href={`mailto:${GULLYBITE_EMAIL}`}>{GULLYBITE_EMAIL}</a></li>
            <li>{GULLYBITE_CITY}, India</li>
          </ul>
        </div>
      </div>
      <div className="lfooter-bottom">
        <div>© {new Date().getFullYear()} GullyBite. All rights reserved.</div>
        <div style={{ display: 'flex', gap: '1.2rem' }}>
          <a href="#">Privacy</a>
          <a href="#">Terms</a>
        </div>
      </div>
    </footer>
  );
}

