import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useToast } from '../components/Toast.jsx';
import { routeByStatus } from '../utils/routeByStatus.js';
import PgOnboard from './landing/PgOnboard.jsx';
import PgConnect from './landing/PgConnect.jsx';
import PgPending from './landing/PgPending.jsx';
import PgRejected from './landing/PgRejected.jsx';
import LandingNav from '../components/landing/LandingNav.jsx';
import LandingHero from '../components/landing/LandingHero.jsx';
import StatsStrip from '../components/landing/StatsStrip.jsx';
import SectionProblem from '../components/landing/SectionProblem.jsx';
import SectionSolution from '../components/landing/SectionSolution.jsx';
import SectionPositioning from '../components/landing/SectionPositioning.jsx';
import SectionHowItWorks from '../components/landing/SectionHowItWorks.jsx';
import SectionFeatures from '../components/landing/SectionFeatures.jsx';
import SectionComparison from '../components/landing/SectionComparison.jsx';
import RoiCalculator from '../components/landing/RoiCalculator.jsx';
import SectionPricing from '../components/landing/SectionPricing.jsx';
import SectionFaq from '../components/landing/SectionFaq.jsx';
import SectionFinalCta from '../components/landing/SectionFinalCta.jsx';
import SectionFooter from '../components/landing/SectionFooter.jsx';
import FloatingWhatsApp from '../components/landing/FloatingWhatsApp.jsx';
import ExitIntentPopup from '../components/landing/ExitIntentPopup.jsx';

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
      <LandingNav onSignIn={goSignin} onGetStarted={goSignup} />
      <LandingHero onGetStarted={goSignup} />
      <StatsStrip />
      <SectionProblem />
      <SectionSolution />
      <SectionPositioning />
      <SectionHowItWorks />
      <SectionFeatures />
      <SectionComparison />
      <RoiCalculator onGetStarted={goSignup} />
      <SectionPricing onGetStarted={goSignup} />
      <SectionFaq />
      <SectionFinalCta onGetStarted={goSignup} />
      <SectionFooter />
      <FloatingWhatsApp />
      <ExitIntentPopup onSignUp={goSignup} />
    </div>
  );
}
