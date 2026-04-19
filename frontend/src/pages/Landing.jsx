import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useToast } from '../components/Toast.jsx';
import { routeByStatus } from '../utils/routeByStatus.js';
import PgOnboard from './landing/PgOnboard.jsx';
import PgConnect from './landing/PgConnect.jsx';
import PgPending from './landing/PgPending.jsx';
import PgRejected from './landing/PgRejected.jsx';

// Maps URL ?page= values and legacy showPage('pg-<id>') calls to the internal
// activePage state. Any unknown id falls back to 'land'.
const PAGE_IDS = {
  land: 'land',
  onboard: 'onboard',
  connect: 'connect',
  pending: 'pending',
  rejected: 'rejected',
  'pg-land': 'land',
  'pg-onboard': 'onboard',
  'pg-connect': 'connect',
  'pg-pending': 'pending',
  'pg-rejected': 'rejected',
};

export default function Landing() {
  const navigate = useNavigate();
  const { user, loading, logout } = useAuth();
  const { showToast } = useToast();
  const bootedRef = useRef(false);
  const toastRef = useRef(showToast);
  toastRef.current = showToast;

  const [activePage, setActivePage] = useState('land');
  const [brandNameHint, setBrandNameHint] = useState(null);

  const showPage = useCallback((id) => {
    const next = PAGE_IDS[id] || 'land';
    setActivePage(next);
    if (typeof window !== 'undefined') window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get('error')) {
      toastRef.current('Authentication failed — please try again', 'error');
      window.history.replaceState({}, '', window.location.pathname);
    }
    const googleToken = params.get('google_token');
    if (googleToken) {
      localStorage.setItem('zm_token', googleToken);
      window.history.replaceState({}, '', window.location.pathname);
      // AuthContext's mount bootstrap picks up the token, fetches /auth/me,
      // and the user-routing effect below runs routeByStatus once user loads.
    }
    const pageParam = params.get('page');
    if (pageParam && PAGE_IDS[pageParam]) {
      setActivePage(PAGE_IDS[pageParam]);
      const stripped = new URLSearchParams(window.location.search);
      stripped.delete('page');
      const qs = stripped.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) return;
    routeByStatus(user, { showPage, navigate });
  }, [user, loading, navigate, showPage]);

  const goSignup = () => navigate('/login?mode=signup');
  const goSignin = () => navigate('/login');

  if (activePage === 'onboard') {
    return (
      <PgOnboard
        onLogout={logout}
        onAdvance={() => showPage('pg-connect')}
        onBrandNameChange={setBrandNameHint}
      />
    );
  }
  if (activePage === 'connect') {
    return (
      <PgConnect
        onLogout={logout}
        showPage={showPage}
        brandNameHint={brandNameHint}
      />
    );
  }
  if (activePage === 'pending') {
    return <PgPending onLogout={logout} showPage={showPage} />;
  }
  if (activePage === 'rejected') {
    return <PgRejected onLogout={logout} showPage={showPage} />;
  }

  return (
    <div id="pg-land">
      <nav className="nav">
        <div className="logo"><div className="logo-ring">🍜</div>GullyBite</div>
        <div className="nav-links">
          <button type="button" className="btn-outline" onClick={goSignin}>Sign In</button>
          <button type="button" className="btn-primary" onClick={goSignup}>Sign Up →</button>
        </div>
      </nav>

      <section className="hero-section">
        <div className="hero">
          <div className="hero-pill"><span></span> Now live across 12+ cities in India</div>
          <h1>
            Turn WhatsApp into your<br />
            <span className="wa-green">restaurant's</span> <span className="accent">ordering engine</span>
          </h1>
          <p className="hero-sub">
            GullyBite connects your menu to WhatsApp in minutes. Customers browse, order and pay — no app,
            no Swiggy, no commission. Just direct orders straight to your kitchen.
          </p>
          <div className="hero-btns">
            <button type="button" className="btn-hero" onClick={goSignup}>🚀 Start for Free — No card needed</button>
            <button type="button" className="btn-hero-ghost" onClick={goSignin}>Sign In to Dashboard</button>
          </div>

          <div className="hero-mockup">
            <div className="mock-topbar">
              <div className="mock-dot" style={{ background: '#ef4444' }}></div>
              <div className="mock-dot" style={{ background: '#f59e0b', marginLeft: 4 }}></div>
              <div className="mock-dot" style={{ background: '#22c55e', marginLeft: 4 }}></div>
              <div className="mock-title">GullyBite Dashboard — Spice Route Kitchen</div>
            </div>
            <div className="mock-body">
              <div className="mock-stats">
                <div className="mock-stat"><div className="mock-stat-v">24</div><div className="mock-stat-l">Today's Orders</div></div>
                <div className="mock-stat"><div className="mock-stat-v" style={{ color: '#16a34a' }}>₹12,480</div><div className="mock-stat-l">Today's Revenue</div></div>
                <div className="mock-stat"><div className="mock-stat-v">6</div><div className="mock-stat-l">Active Orders</div></div>
                <div className="mock-stat"><div className="mock-stat-v">₹50K</div><div className="mock-stat-l">Weekly Revenue</div></div>
              </div>
              <table className="mock-table">
                <thead>
                  <tr><th>Order</th><th>Customer</th><th>Branch</th><th>Items</th><th>Total</th><th>Status</th><th>Action</th></tr>
                </thead>
                <tbody>
                  <tr><td>#GB-1042</td><td>Priya M.</td><td>Koramangala</td><td>Butter Chicken + Naan ×2</td><td>₹680</td><td><span className="mock-badge prep">Preparing</span></td><td><button type="button" className="mock-btn">Confirm</button></td></tr>
                  <tr><td>#GB-1041</td><td>Rahul K.</td><td>Indiranagar</td><td>Biryani ×1</td><td>₹320</td><td><span className="mock-badge paid">Paid</span></td><td><button type="button" className="mock-btn">Start Prep</button></td></tr>
                  <tr><td>#GB-1040</td><td>Sneha R.</td><td>HSR Layout</td><td>Paneer Tikka + Dal Makhani</td><td>₹520</td><td><span className="mock-badge done">Delivered</span></td><td><button type="button" className="mock-btn">Mark Packed</button></td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <div className="stats-strip">
        <div className="stats-inner">
          <div>
            <div className="strip-stat-v">₹0</div>
            <div className="strip-stat-l">Commission on every order</div>
          </div>
          <div>
            <div className="strip-stat-v">2 min</div>
            <div className="strip-stat-l">To go live on WhatsApp</div>
          </div>
          <div>
            <div className="strip-stat-v">100%</div>
            <div className="strip-stat-l">Native WhatsApp checkout</div>
          </div>
          <div>
            <div className="strip-stat-v">24/7</div>
            <div className="strip-stat-l">Automated order management</div>
          </div>
        </div>
      </div>

      <section className="section" style={{ background: 'var(--bg)' }}>
        <div className="section-center">
          <div className="section-head" style={{ textAlign: 'center' }}>
            <div className="section-pill">How it works</div>
            <h2 className="section-title">From signup to first order in under 10 minutes</h2>
            <p className="section-sub" style={{ margin: '0 auto' }}>Three simple steps and your restaurant is live on WhatsApp — no technical setup, no developer needed.</p>
          </div>
          <div className="steps-grid">
            <div className="step-card">
              <div className="step-num">01</div>
              <h3>Register &amp; Submit Details</h3>
              <p>Create your account, fill in your restaurant's business details, FSSAI license and bank information. Our team verifies and activates your account within 1–2 business days.</p>
            </div>
            <div className="step-card">
              <div className="step-num">02</div>
              <h3>Connect WhatsApp Business</h3>
              <p>Link your Meta / WhatsApp Business account with one click. GullyBite auto-creates a product catalog for each branch and configures the order webhook — no code required.</p>
            </div>
            <div className="step-card">
              <div className="step-num">03</div>
              <h3>Add Menu &amp; Start Selling</h3>
              <p>Upload your menu via CSV or add items one by one. Customers can browse your catalog, add to cart and pay via UPI or card — entirely inside WhatsApp. Orders flow to your dashboard in real time.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section features-section">
        <div className="section-center">
          <div className="section-head" style={{ textAlign: 'center' }}>
            <div className="section-pill">Platform features</div>
            <h2 className="section-title">Everything a modern restaurant needs</h2>
            <p className="section-sub" style={{ margin: '0 auto' }}>Built specifically for Indian restaurants. No bloat, no per-order cut — just tools that help you sell more.</p>
          </div>
          <div className="feats-grid">
            <div className="feat-card">
              <div className="feat-icon indigo">📍</div>
              <h3>Location-Based Branch Routing</h3>
              <p>Customer shares their GPS location → GullyBite detects the nearest branch → shows only that branch's catalog. Multi-city coverage built in.</p>
            </div>
            <div className="feat-card">
              <div className="feat-icon green">🛒</div>
              <h3>Native WhatsApp Cart &amp; Checkout</h3>
              <p>Customers browse, build their cart and confirm orders entirely inside WhatsApp. No app download, no browser redirect, no friction.</p>
            </div>
            <div className="feat-card">
              <div className="feat-icon amber">⚡</div>
              <h3>Auto Catalog Creation</h3>
              <p>Add a branch and GullyBite instantly creates a dedicated Meta product catalog via API. Menu changes sync in seconds — toggle an item unavailable and it's gone from WhatsApp immediately.</p>
            </div>
            <div className="feat-card">
              <div className="feat-icon blue">💳</div>
              <h3>Razorpay Payment Integration</h3>
              <p>UPI, cards, net banking — GullyBite sends a payment link over WhatsApp. Payments are reconciled automatically. Auto-refund on cancelled orders.</p>
            </div>
            <div className="feat-card">
              <div className="feat-icon violet">🏷️</div>
              <h3>Coupons &amp; Discount Codes</h3>
              <p>Create percent or flat-amount discount codes with usage limits, minimum order thresholds and expiry dates. Customers apply codes directly during WhatsApp checkout.</p>
            </div>
            <div className="feat-card">
              <div className="feat-icon indigo">📋</div>
              <h3>WhatsApp Message Templates</h3>
              <p>Map approved Meta message templates to order events — Confirmed, Preparing, Dispatched, Delivered. Variables like order number and ETA are filled automatically.</p>
            </div>
            <div className="feat-card">
              <div className="feat-icon green">🔗</div>
              <h3>Referral &amp; Affiliate Links</h3>
              <p>Admin sends a restaurant's WhatsApp link to a prospective customer. If they order within 8 hours, a transparent 7.5% referral fee applies — tracked in both dashboards.</p>
            </div>
            <div className="feat-card">
              <div className="feat-icon amber">📊</div>
              <h3>Real-Time Order Dashboard</h3>
              <p>Live order stream with status management — Confirm → Preparing → Packed → Dispatched. Analytics on revenue, top items, busiest hours and customer retention.</p>
            </div>
            <div className="feat-card">
              <div className="feat-icon rose">💰</div>
              <h3>Weekly Automatic Settlements</h3>
              <p>Every Monday, your payout is calculated and transferred: gross revenue minus platform fee and delivery cost. Full itemised breakdown in the Settlements tab.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-center">
          <div className="section-head" style={{ textAlign: 'center' }}>
            <div className="section-pill">Why GullyBite</div>
            <h2 className="section-title">Stop paying 25–30% to aggregators</h2>
            <p className="section-sub" style={{ margin: '0 auto' }}>Swiggy and Zomato take up to 30% of every order. GullyBite charges a flat monthly platform fee — and nothing more.</p>
          </div>
          <div className="compare-grid">
            <div className="compare-card them">
              <h3>❌ Swiggy / Zomato</h3>
              <div className="compare-row"><span className="cico">✗</span>25–30% commission per order</div>
              <div className="compare-row"><span className="cico">✗</span>You don't own the customer</div>
              <div className="compare-row"><span className="cico">✗</span>Delayed weekly payouts</div>
              <div className="compare-row"><span className="cico">✗</span>Controlled by platform algorithm</div>
              <div className="compare-row"><span className="cico">✗</span>No direct customer communication</div>
              <div className="compare-row"><span className="cico">✗</span>Paid ads to stay visible</div>
            </div>
            <div className="compare-card us">
              <h3 style={{ color: 'var(--acc)' }}>✅ GullyBite</h3>
              <div className="compare-row good"><span className="cico" style={{ color: 'var(--wa)' }}>✓</span>Flat monthly fee, zero commission</div>
              <div className="compare-row good"><span className="cico" style={{ color: 'var(--wa)' }}>✓</span>Direct WhatsApp relationship with customers</div>
              <div className="compare-row good"><span className="cico" style={{ color: 'var(--wa)' }}>✓</span>Weekly automated bank transfers</div>
              <div className="compare-row good"><span className="cico" style={{ color: 'var(--wa)' }}>✓</span>Your menu, your brand, your catalog</div>
              <div className="compare-row good"><span className="cico" style={{ color: 'var(--wa)' }}>✓</span>Message customers via WhatsApp anytime</div>
              <div className="compare-row good"><span className="cico" style={{ color: 'var(--wa)' }}>✓</span>No ads, no algorithm — just orders</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" style={{ background: 'var(--bg)', borderTop: '1px solid var(--rim)' }}>
        <div className="section-center">
          <div className="section-head" style={{ textAlign: 'center' }}>
            <div className="section-pill">Simple pricing</div>
            <h2 className="section-title">One plan. No surprises.</h2>
            <p className="section-sub" style={{ margin: '0 auto' }}>No per-order commission, no hidden fees. Just a predictable monthly subscription so you keep what you earn.</p>
          </div>
          <div className="pricing-card">
            <div className="pricing-badge">Restaurant Plan</div>
            <div className="pricing-price">₹2,999<span>/month</span></div>
            <div className="pricing-sub">Billed monthly · Cancel anytime · GST extra</div>
            <ul className="pricing-feats">
              <li>Unlimited orders — no per-order commission</li>
              <li>Up to 5 branches &amp; locations</li>
              <li>Unlimited menu items &amp; catalog sync</li>
              <li>WhatsApp ordering, cart &amp; checkout</li>
              <li>Razorpay payment collection built in</li>
              <li>Coupon &amp; discount system</li>
              <li>Message template automation</li>
              <li>Real-time order dashboard &amp; analytics</li>
              <li>Weekly automatic bank settlements</li>
              <li>Dedicated onboarding support</li>
            </ul>
            <button type="button" className="btn-full" onClick={goSignup}>Get Started Free →</button>
            <p className="pricing-note">First 14 days free. No credit card required to sign up.</p>
          </div>
        </div>
      </section>

      <section className="cta-section">
        <h2>Ready to own your orders?</h2>
        <p>Join restaurants across India who've switched from aggregators to direct WhatsApp ordering with GullyBite.</p>
        <button type="button" className="btn-cta" onClick={goSignup}>🚀 Start Your Free Trial</button>
      </section>

      <footer className="footer">
        <div className="footer-logo">
          <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--acc)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '.75rem' }}>🍜</div>
          GullyBite
        </div>
        <div className="footer-links">
          <a href="mailto:support@gullybite.com">support@gullybite.com</a>
          <a href="#">Privacy Policy</a>
          <a href="#">Terms</a>
        </div>
        <div className="footer-copy">© 2025 GullyBite. All rights reserved.</div>
      </footer>
    </div>
  );
}
