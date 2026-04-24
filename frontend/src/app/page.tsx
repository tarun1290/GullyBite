'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import { routeByStatus } from '../utils/routeByStatus';
import PgOnboard from '../components/landing/pages/PgOnboard';
import PgConnect from '../components/landing/pages/PgConnect';
import PgPending from '../components/landing/pages/PgPending';
import PgRejected from '../components/landing/pages/PgRejected';
import LandingNav from '../components/landing/LandingNav';
import LandingHero from '../components/landing/LandingHero';
import StatsStrip from '../components/landing/StatsStrip';
import SectionProblem from '../components/landing/SectionProblem';
import SectionSolution from '../components/landing/SectionSolution';
import SectionPositioning from '../components/landing/SectionPositioning';
import SectionHowItWorks from '../components/landing/SectionHowItWorks';
import SectionFeatures from '../components/landing/SectionFeatures';
import SectionComparison from '../components/landing/SectionComparison';
import RoiCalculator from '../components/landing/RoiCalculator';
import SectionPricing from '../components/landing/SectionPricing';
import SectionFaq from '../components/landing/SectionFaq';
import SectionFinalCta from '../components/landing/SectionFinalCta';
import SectionFooter from '../components/landing/SectionFooter';
import FloatingWhatsApp from '../components/landing/FloatingWhatsApp';
import ExitIntentPopup from '../components/landing/ExitIntentPopup';

type ActivePage = 'land' | 'onboard' | 'connect' | 'pending' | 'rejected';

const PAGE_IDS: Record<string, ActivePage> = {
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
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const { showToast } = useToast();
  const bootedRef = useRef(false);
  const toastRef = useRef(showToast);
  toastRef.current = showToast;

  const [activePage, setActivePage] = useState<ActivePage>('land');
  const [brandNameHint, setBrandNameHint] = useState<string | null>(null);

  const showPage = useCallback((id: string) => {
    const next = PAGE_IDS[id] || 'land';
    setActivePage(next);
    if (typeof window !== 'undefined') window.scrollTo(0, 0);
  }, []);

  const navigate = useCallback((path: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) router.replace(path);
    else router.push(path);
  }, [router]);

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

  const goSignup = () => router.push('/login?mode=signup');
  const goSignin = () => router.push('/login');

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
