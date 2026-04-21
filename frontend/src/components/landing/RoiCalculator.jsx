import { useMemo, useState } from 'react';

const MONTHLY_FEE = 2999;

function fmtInr(n) {
  const v = Math.max(0, Math.round(n));
  return '₹' + v.toLocaleString('en-IN');
}

export default function RoiCalculator({ onSignUp }) {
  const [ordersPerDay, setOrdersPerDay] = useState(50);
  const [aov, setAov] = useState(500);
  const [commissionPct, setCommissionPct] = useState(28);

  const numbers = useMemo(() => {
    const monthlyOrders = ordersPerDay * 30;
    const gross = monthlyOrders * aov;
    const aggCut = gross * (commissionPct / 100);
    const gbCost = MONTHLY_FEE;
    const youKeepAgg = gross - aggCut;
    const youKeepGb = gross - gbCost;
    const savings = youKeepGb - youKeepAgg;
    return { monthlyOrders, gross, aggCut, gbCost, youKeepAgg, youKeepGb, savings };
  }, [ordersPerDay, aov, commissionPct]);

  return (
    <section className="lsection" id="calculator">
      <div className="lsection-inner">
        <div className="lsection-head">
          <div className="lsection-pill">ROI Calculator</div>
          <h2 className="lsection-title">See how much you'd save with GullyBite</h2>
          <p className="lsection-sub">Adjust your numbers. The savings are real, every month.</p>
        </div>

        <div className="roi-card">
          <div className="roi-head">
            <div className="label">You'd keep an extra</div>
            <div className="keep">{fmtInr(numbers.savings)}</div>
            <div className="sub">per month vs. Swiggy / Zomato at {commissionPct}% commission</div>
          </div>

          <div className="roi-fields">
            <div className="roi-field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="roi-orders">Orders per day: <strong style={{ color: 'var(--gb-green-700)' }}>{ordersPerDay}</strong></label>
              <input
                id="roi-orders"
                type="range"
                className="roi-slider"
                min="10"
                max="500"
                step="5"
                value={ordersPerDay}
                onChange={(e) => setOrdersPerDay(Number(e.target.value))}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.72rem', color: 'var(--landing-mute)' }}>
                <span>10</span><span>500</span>
              </div>
            </div>

            <div className="roi-field">
              <label htmlFor="roi-aov">Average order value (₹)</label>
              <input
                id="roi-aov"
                type="number"
                min="50"
                step="10"
                value={aov}
                onChange={(e) => setAov(Math.max(0, Number(e.target.value) || 0))}
              />
            </div>

            <div className="roi-field">
              <label htmlFor="roi-comm">Aggregator commission: <strong>{commissionPct}%</strong></label>
              <input
                id="roi-comm"
                type="range"
                className="roi-slider"
                min="15"
                max="35"
                step="1"
                value={commissionPct}
                onChange={(e) => setCommissionPct(Number(e.target.value))}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.72rem', color: 'var(--landing-mute)' }}>
                <span>15%</span><span>35%</span>
              </div>
            </div>
          </div>

          <div className="roi-breakdown">
            <div className="roi-breakdown-row">
              <span>Monthly orders</span>
              <strong>{numbers.monthlyOrders.toLocaleString('en-IN')}</strong>
            </div>
            <div className="roi-breakdown-row">
              <span>Gross revenue</span>
              <strong>{fmtInr(numbers.gross)}</strong>
            </div>
            <div className="roi-breakdown-row">
              <span>Aggregator cut ({commissionPct}%)</span>
              <strong style={{ color: 'var(--gb-red-500)' }}>− {fmtInr(numbers.aggCut)}</strong>
            </div>
            <div className="roi-breakdown-row">
              <span>GullyBite flat fee</span>
              <strong>− {fmtInr(numbers.gbCost)}</strong>
            </div>
            <div className="roi-breakdown-row total">
              <span>Extra in your pocket with GullyBite</span>
              <strong>{fmtInr(numbers.savings)}/mo</strong>
            </div>
          </div>

          <div className="roi-cta">
            <button type="button" className="lbtn lbtn-primary lbtn-lg" onClick={onSignUp}>
              Start Free Trial →
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
