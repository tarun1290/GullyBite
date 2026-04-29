'use client';

// Socket.io connection hook for the restaurant dashboard.
//
// Auth: reads the dashboard JWT from localStorage under 'zm_token' (the
// same key the axios client uses for non-admin requests — see
// frontend/src/lib/apiClient.ts:31). Admins use 'gb_admin_token' but
// they don't consume order events, so this hook only resolves the
// owner / staff token.
//
// Connection target: process.env.NEXT_PUBLIC_API_BASE_URL — the same
// origin the Express+Socket.io server in backend/ec2-server.js is
// served from. Falls back to NEXT_PUBLIC_API_URL for compatibility
// with older env files.

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

const RESTAURANT_TOKEN_KEY = 'zm_token';
const ADMIN_TOKEN_KEY = 'gb_admin_token';

function resolveSocketUrl(): string {
  return (
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    ''
  );
}

// Pick whichever scope has a token in localStorage. Restaurant first
// (most common path); admin scope falls through when the user is on
// /admin/* and only has gb_admin_token. The two scopes never share a
// browser session in practice, but the fallback also makes the hook
// resilient if both happen to coexist (e.g. a developer multi-tabbing).
function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const restaurantToken = window.localStorage.getItem(RESTAURANT_TOKEN_KEY);
    if (restaurantToken) return restaurantToken;
    const adminToken = window.localStorage.getItem(ADMIN_TOKEN_KEY);
    if (adminToken) return adminToken;
    return null;
  } catch {
    return null;
  }
}

interface UseSocketReturn {
  socket: Socket | null;
  connected: boolean;
}

export function useSocket(): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const token = getToken();
    if (!token) return;
    const url = resolveSocketUrl();

    const sock = io(url, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });
    socketRef.current = sock;

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    sock.on('connect', onConnect);
    sock.on('disconnect', onDisconnect);
    // Auth failures from io.use() in ec2-server.js arrive here.
    sock.on('connect_error', () => setConnected(false));

    return () => {
      sock.off('connect', onConnect);
      sock.off('disconnect', onDisconnect);
      sock.disconnect();
      socketRef.current = null;
    };
  }, []);

  return { socket: socketRef.current, connected };
}

export type SocketHook = ReturnType<typeof useSocket>;
