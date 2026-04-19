import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

const ToastContext = createContext(null);

const TYPE_TO_LEGACY = {
  success: 'ok',
  error: 'err',
  info: 'nfo',
  warning: 'nfo',
};

const TYPE_TO_ICON = {
  success: '\u2713',
  error: '\u2717',
  info: '\u2139',
  warning: '\u26A0',
};

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);

  const showToast = useCallback((message, type = 'info') => {
    clearTimeout(timerRef.current);
    setToast({ message, type, ts: Date.now() });
    timerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const legacyType = toast ? TYPE_TO_LEGACY[toast.type] || 'nfo' : '';
  const icon = toast ? TYPE_TO_ICON[toast.type] || '\u2022' : '';
  const className = toast ? `on ${legacyType}` : '';

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div id="toast" className={className}>
        {toast && (
          <>
            <span>{icon}</span>
            <span>{toast.message}</span>
          </>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

export default ToastContext;
