'use client';

import { useCallback } from 'react';
import useMetaOAuth from '../../hooks/useMetaOAuth';
import { useToast } from '../Toast';

const WA_CONNECT_LABEL_DEFAULT = 'Connect WhatsApp Business';

interface WaIconProps {
  size?: number;
}

function WaIcon({ size = 14 }: WaIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="white" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

interface WaConnectBannerProps {
  onConnected?: (() => void) | undefined;
  connected?: boolean;
  compact?: boolean;
}

export default function WaConnectBanner({ onConnected, connected = false, compact = false }: WaConnectBannerProps) {
  const { showToast } = useToast();

  const onSuccess = useCallback(() => {
    showToast('WhatsApp connected!', 'success');
    onConnected?.();
  }, [onConnected, showToast]);

  const onError = useCallback((msg: string) => {
    if (msg) showToast(msg, 'error');
  }, [showToast]);

  const { triggerMetaOAuth, loading } = useMetaOAuth({ onSuccess, onError });

  const handleClick = () => { triggerMetaOAuth({ returnTo: '/dashboard' }); };

  if (compact) {
    if (connected) {
      return (
        <span className="inline-flex items-center gap-[0.35rem] bg-[#dcfce7] text-[#15803d] text-[0.72rem] font-semibold py-1 px-[0.55rem] rounded-md shrink-0">
          ✓ Connected
        </span>
      );
    }
    return (
      <button
        type="button"
        className="btn-wa-connect btn-sm shrink-0"
        onClick={handleClick}
        disabled={loading}
      >
        {loading ? (<><span className="spin" /> Connecting…</>) : (<><WaIcon size={14} /> {WA_CONNECT_LABEL_DEFAULT}</>)}
      </button>
    );
  }

  if (connected) {
    return (
      <div
        id="wa-connect-banner"
        className="flex items-center gap-3 bg-[#f0fdf4] border-b-2 border-[#22c55e] py-4 px-8"
      >
        <span className="text-[1.4rem]">✅</span>
        <div>
          <div className="font-bold text-[0.9rem] text-[#15803d]">
            WhatsApp Business connected
          </div>
          <div className="text-[0.8rem] text-[#166534] mt-[0.15rem]">
            You&apos;re ready to receive orders.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      id="wa-connect-banner"
      className="flex items-center justify-between gap-4 flex-wrap bg-[#fffbeb] border-b-2 border-[#f59e0b] py-4 px-8"
    >
      <div className="flex items-center gap-3">
        <span className="text-[1.4rem]">📵</span>
        <div>
          <div className="font-bold text-[0.9rem] text-[#92400e]">
            WhatsApp Business not connected
          </div>
          <div className="text-[0.8rem] text-[#b45309] mt-[0.15rem]">
            Connect WhatsApp to start receiving orders. All selling features are locked until connected.
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className="btn-wa-connect"
          onClick={handleClick}
          disabled={loading}
        >
          {loading ? (<><span className="spin" /> Connecting…</>) : (<><WaIcon size={14} /> {WA_CONNECT_LABEL_DEFAULT}</>)}
        </button>
      </div>
    </div>
  );
}
