import WaConnectBanner from './WaConnectBanner.jsx';

// Mirrors the legacy #ob / #ob-steps wizard rendered by overview.js:95-137.
// Each step is a status row (done or current) plus an action button.
// Completion is derived from other API state — completing a step never issues
// its own API call here (consistent with legacy; the user navigates to the
// relevant tab to perform the underlying work).
//
// Step shape:
//   {
//     id: string,
//     label: string,
//     description: string,
//     done: boolean,
//     cta?: 'wa-connect',      // renders the shared WhatsApp connect button
//     onAction?: () => void,   // fires when the row's action button is clicked
//   }
export default function SetupWizard({ steps, onWaConnected }) {
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
