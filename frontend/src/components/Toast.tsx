'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

interface ToastState {
  message: string;
  type: ToastType;
  ts: number;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TYPE_TO_LEGACY: Record<ToastType, string> = {
  success: 'ok',
  error: 'err',
  info: 'nfo',
  warning: 'nfo',
};

const TYPE_TO_ICON: Record<ToastType, string> = {
  success: '✓',
  error: '✗',
  info: 'ℹ',
  warning: '⚠',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setToast({ message, type, ts: Date.now() });
    timerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const legacyType = toast ? TYPE_TO_LEGACY[toast.type] || 'nfo' : '';
  const icon = toast ? TYPE_TO_ICON[toast.type] || '•' : '';
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

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

export default ToastContext;
