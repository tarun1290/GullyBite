import { useMemo, useState } from 'react';

const DEFAULT_ORDERS = 50;
const DEFAULT_AOV = 500;
const DEFAULT_COMMISSION = 28;
const GULLYBITE_COST = 2999;

const ORDERS_MIN = 10;
const ORDERS_MAX = 500;
const COMMISSION_MIN = 15;
const COMMISSION_MAX = 35;

const inrFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmtInt = (n) => inrFormatter.format(Math.max(0, Math.round(n)));
const fmtInr = (n) => '\u20B9' + fmtInt(n);

function clampNumber(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export default function RoiCalculator({ onGetStarted }) {
  const [ordersPerDay, setOrdersPerDay] = useState(DEFAULT_ORDERS);
  const [avgOrderValue, setAvgOrderValue] = useState(DEFAULT_AOV);
  const [commissionPct, setCommissionPct] = useState(DEFAULT_COMMISSION);

  const numbers = useMemo(() => {
    const monthlyOrders = ordersPerDay * 30;
    const monthlyRevenue = monthlyOrders * avgOrderValue;
    const aggregatorCost = monthlyRevenue * (commissionPct / 100);
    const youKeep = aggregatorCost - GULLYBITE_COST;
    return { monthlyOrders, monthlyRevenue, aggregatorCost, youKeep };
  }, [ordersPerDay, avgOrderValue, commissionPct]);

  return (
    <section className="landing-roi" id="calculator">
      <div className="landing-roi-inner">
        <div className="landing-roi-head">
          <div className="landing-roi-eyebrow">ROI calculator</div>
          <h2 className="landing-roi-headline">Do the math on your own kitchen.</h2>
          <p className="landing-roi-sub">
            Drag the sliders. The numbers update live. No sign-up, no credit card.
          </p>
        </div>

        <div className="landing-roi-grid">
          <div className="landing-roi-controls">
            <div className="landing-roi-field">
              <div className="landing-roi-field-label">
                <label htmlFor="roi-orders">Orders per day</label>
                <strong className="landing-roi-field-value">{fmtInt(ordersPerDay)}</strong>
              </div>
              <input
                id="roi-orders"
                type="range"
                className="landing-roi-range"
                min={ORDERS_MIN}
                max={ORDERS_MAX}
                step="5"
                value={ordersPerDay}
                onChange={(e) =>
                  setOrdersPerDay(clampNumber(e.target.value, ORDERS_MIN, ORDERS_MAX, DEFAULT_ORDERS))
                }
              />
              <div className="landing-roi-range-scale">
                <span>{ORDERS_MIN}</span>
                <span>{ORDERS_MAX}</span>
              </div>
            </div>

            <div className="landing-roi-field">
              <label htmlFor="roi-aov" className="landing-roi-field-label">
                <span>Average order value (&#8377;)</span>
              </label>
              <input
                id="roi-aov"
                type="number"
                min="50"
                step="10"
                inputMode="numeric"
                className="landing-roi-input"
                value={avgOrderValue}
                onChange={(e) => setAvgOrderValue(clampNumber(e.target.value, 0, 100000, DEFAULT_AOV))}
              />
            </div>

            <div className="landing-roi-field">
              <label htmlFor="roi-commission" className="landing-roi-field-label">
                <span>Commission on aggregator (%)</span>
              </label>
              <input
                id="roi-commission"
                type="number"
                min={COMMISSION_MIN}
                max={COMMISSION_MAX}
                step="1"
                inputMode="numeric"
                className="landing-roi-input"
                value={commissionPct}
                onChange={(e) =>
                  setCommissionPct(clampNumber(e.target.value, COMMISSION_MIN, COMMISSION_MAX, DEFAULT_COMMISSION))
                }
              />
              <div className="landing-roi-range-scale">
                <span>min {COMMISSION_MIN}%</span>
                <span>max {COMMISSION_MAX}%</span>
              </div>
            </div>
          </div>

          <div className="landing-roi-results">
            <div className="landing-roi-result-row">
              <span className="landing-roi-result-label">Monthly orders</span>
              <strong className="landing-roi-result-value">{fmtInt(numbers.monthlyOrders)}</strong>
            </div>
            <div className="landing-roi-result-row">
              <span className="landing-roi-result-label">Revenue lost to aggregator</span>
              <strong className="landing-roi-result-value landing-roi-result-loss">
                {fmtInr(numbers.aggregatorCost)}
              </strong>
            </div>
            <div className="landing-roi-result-row">
              <span className="landing-roi-result-label">GullyBite cost</span>
              <strong className="landing-roi-result-value">{fmtInr(GULLYBITE_COST)}</strong>
            </div>
            <div className="landing-roi-keep">
              <div className="landing-roi-keep-label">You keep</div>
              <div className="landing-roi-keep-value">{fmtInr(numbers.youKeep)}</div>
              <div className="landing-roi-keep-note">per month, vs paying aggregator commission</div>
            </div>
            <button
              type="button"
              className="landing-btn-primary landing-btn-lg landing-roi-cta"
              onClick={onGetStarted}
            >
              Start Keeping This Money &rarr;
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
