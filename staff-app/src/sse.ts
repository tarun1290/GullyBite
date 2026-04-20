// SSE client with exponential backoff reconnect. Uses react-native-sse
// (which lets us set Authorization — raw EventSource in browsers can't).
// Emits three states so the UI can render a Live/Reconnecting pill.

import EventSource from 'react-native-sse';
import { apiBase } from './api';
import { getToken } from './storage';

export type SseState = 'connecting' | 'live' | 'reconnecting';

type Handlers = {
  onNewOrder: (payload: any) => void;
  onOrderUpdated?: (payload: any) => void;
  onState: (state: SseState) => void;
};

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export class StaffSse {
  private es: EventSource | null = null;
  private handlers: Handlers;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(handlers: Handlers) {
    this.handlers = handlers;
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    this.handlers.onState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const token = await getToken();
    if (!token) {
      // No credentials — back off until the caller closes us or retries.
      this.scheduleReconnect();
      return;
    }
    const url = `${apiBase()}/api/staff/stream?token=${encodeURIComponent(token)}`;
    // Also send Authorization for servers that prefer headers.
    const es = new EventSource(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    es.addEventListener('open', () => {
      this.attempt = 0;
      this.handlers.onState('live');
    });

    es.addEventListener('message', (ev: any) => {
      this.dispatch(ev?.data);
    });

    // Named event support — backend may dispatch 'new_order' or 'order_update'.
    (es as any).addEventListener('new_order', (ev: any) => {
      this.dispatch(ev?.data, 'new_order');
    });
    (es as any).addEventListener('order_update', (ev: any) => {
      this.dispatch(ev?.data, 'order_update');
    });

    es.addEventListener('error', () => {
      this.handlers.onState('reconnecting');
      try { es.close(); } catch { /* noop */ }
      if (this.es === es) this.es = null;
      this.scheduleReconnect();
    });

    this.es = es;
  }

  private dispatch(raw: string | undefined, kind?: 'new_order' | 'order_update'): void {
    if (!raw || raw.startsWith(':')) return; // heartbeat line
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { return; }
    const eventType = kind || parsed?.event_type;
    if (eventType === 'new_order') {
      this.handlers.onNewOrder(parsed);
    } else if (eventType === 'order_update' && this.handlers.onOrderUpdated) {
      this.handlers.onOrderUpdated(parsed);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.es) {
      try { this.es.close(); } catch { /* noop */ }
      this.es = null;
    }
  }
}
