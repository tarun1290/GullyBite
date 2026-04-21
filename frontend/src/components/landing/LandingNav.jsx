import { useEffect, useState } from 'react';

const LINKS = [
  ['Why GullyBite', 'problem'],
  ['Features', 'features'],
  ['Pricing', 'pricing'],
  ['FAQ', 'faq'],
];

export default function LandingNav({ onGetStarted, onSignIn }) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const go = (id) => (e) => {
    e.preventDefault();
    setMenuOpen(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav className={`landing-nav${scrolled ? ' is-scrolled' : ''}`}>
      <div className="landing-nav-inner">
        <a className="landing-nav-brand" href="#top" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
          <span className="landing-nav-logo" aria-hidden="true">GB</span>
          <span>GullyBite</span>
        </a>

        <div className="landing-nav-links" role="navigation">
          {LINKS.map(([label, id]) => (
            <a key={id} href={`#${id}`} onClick={go(id)}>{label}</a>
          ))}
        </div>

        <div className="landing-nav-cta">
          <button type="button" className="landing-btn-ghost landing-nav-signin" onClick={onSignIn}>Sign In</button>
          <button type="button" className="landing-btn-primary" onClick={onGetStarted}>Get Started Free</button>
          <button
            type="button"
            className="landing-nav-burger"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span /><span /><span />
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="landing-nav-mobile">
          {LINKS.map(([label, id]) => (
            <a key={id} href={`#${id}`} onClick={go(id)}>{label}</a>
          ))}
          <button type="button" className="landing-btn-ghost" onClick={() => { setMenuOpen(false); onSignIn?.(); }}>Sign In</button>
        </div>
      )}
    </nav>
  );
}
