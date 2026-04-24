'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'gb_exit_shown_v1';

interface ExitIntentPopupProps {
  onSignUp?: () => void;
}

export default function ExitIntentPopup({ onSignUp }: ExitIntentPopupProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(max-width: 900px)').matches) return;
    if (sessionStorage.getItem(STORAGE_KEY)) return;

    const onLeave = (e: MouseEvent) => {
      if (e.clientY > 10) return;
      if (sessionStorage.getItem(STORAGE_KEY)) return;
      sessionStorage.setItem(STORAGE_KEY, '1');
      setOpen(true);
    };
    document.addEventListener('mouseleave', onLeave);
    return () => document.removeEventListener('mouseleave', onLeave);
  }, []);

  if (!open) return null;

  const scrollToCalc = () => {
    setOpen(false);
    const el = document.getElementById('calculator');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="exit-backdrop" onClick={() => setOpen(false)}>
      <div className="exit-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="exit-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
        <div style={{ fontSize: '2.4rem', marginBottom: '.5rem' }}>💰</div>
        <h3>Before you go — see your savings</h3>
        <p>Find out exactly how much you'd keep by switching from Swiggy / Zomato to GullyBite. Takes 10 seconds.</p>
        <div style={{ display: 'flex', gap: '.6rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="lbtn lbtn-primary lbtn-lg" onClick={scrollToCalc}>Show me the calculator</button>
          <button type="button" className="lbtn lbtn-ghost lbtn-lg" onClick={() => { setOpen(false); onSignUp?.(); }}>Start Free Trial</button>
        </div>
      </div>
    </div>
  );
}
