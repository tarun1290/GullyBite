import { Link } from 'react-router-dom';
import { GULLYBITE_EMAIL, GULLYBITE_CITY } from '../../config/contact.js';
import { waLink } from '../../utils/whatsapp.js';

function goAnchor(id) {
  return (e) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

export default function SectionFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="landing-footer">
      <div className="landing-footer-inner">
        <div className="landing-footer-brand">
          <div className="landing-footer-logo">
            <span aria-hidden="true">GB</span>
            <span>GullyBite</span>
          </div>
          <p className="landing-footer-tagline">
            The Shopify for F&amp;B Industry.
            <br />
            Zero commission. Full customer ownership.
          </p>
        </div>

        <div className="landing-footer-col">
          <h4 className="landing-footer-h">Product</h4>
          <ul>
            <li><a href="#features" onClick={goAnchor('features')}>Features</a></li>
            <li><a href="#pricing" onClick={goAnchor('pricing')}>Pricing</a></li>
            <li><a href="#how-it-works" onClick={goAnchor('how-it-works')}>How it works</a></li>
            <li><a href="#faq" onClick={goAnchor('faq')}>FAQ</a></li>
          </ul>
        </div>

        <div className="landing-footer-col">
          <h4 className="landing-footer-h">Company</h4>
          <ul>
            {/* TODO: /about page doesn't exist yet — swap when it ships */}
            <li><a href="#">About</a></li>
            {/* TODO: /contact page doesn't exist yet — swap when it ships */}
            <li><a href="#">Contact</a></li>
            <li><Link to="/privacy">Privacy Policy</Link></li>
            <li><Link to="/terms">Terms of Service</Link></li>
          </ul>
        </div>

        <div className="landing-footer-col">
          <h4 className="landing-footer-h">Get in touch</h4>
          <ul>
            <li>
              <a href={waLink()} target="_blank" rel="noopener noreferrer">
                WhatsApp us
              </a>
            </li>
            <li>
              <a href={`mailto:${GULLYBITE_EMAIL}`}>{GULLYBITE_EMAIL}</a>
            </li>
            <li className="landing-footer-plain">{GULLYBITE_CITY}, India</li>
          </ul>
        </div>
      </div>

      <div className="landing-footer-bottom">
        <span>
          &copy; {year} GullyBite. A Doteye Labs product. Made in India for Indian restaurants.
        </span>
      </div>
    </footer>
  );
}
