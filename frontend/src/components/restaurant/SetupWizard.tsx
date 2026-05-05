'use client';

import WaConnectBanner from './WaConnectBanner';

export interface WizardStep {
  id: string;
  label: string;
  description: string;
  done: boolean;
  cta?: string;
  onAction?: () => void;
}

interface SetupWizardProps {
  steps: WizardStep[];
  onWaConnected?: () => void;
}

export default function SetupWizard({ steps, onWaConnected }: SetupWizardProps) {
  if (!steps || steps.every((s) => s.done)) return null;

  return (
    <div className="ob" id="ob">
      <h3>🚀 Complete your setup to go live</h3>
      <div id="ob-steps">
        {steps.map((step, i) => {
          const n = i + 1;
          const cls = step.done ? 'wz-done' : 'wz-cur';
          const showAction = !step.done && (step.cta === 'wa-connect' || step.onAction);

          return (
            <div className="wz" key={step.id || i}>
              <div className={`wz-n ${cls}`}>{step.done ? '✓' : n}</div>
              <div style={{ flex: 1 }}>
                <b>{step.label}</b>
                <p>{step.description}</p>
              </div>
              {showAction && step.cta === 'wa-connect' && (
                <WaConnectBanner compact onConnected={onWaConnected} />
              )}
              {showAction && step.cta !== 'wa-connect' && step.onAction && (
                <button
                  type="button"
                  className="btn-g btn-sm"
                  style={{ flexShrink: 0 }}
                  onClick={step.onAction}
                >
                  Go →
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
