// Stable per-device identifier used for the staff push-token registry.
// Hashed from device model + OS fields so we don't rely on any privacy-
// restricted IDs. Persisted in SecureStore after first generation so the
// value stays stable even if device fields change between OS upgrades.

import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { getDeviceId, setDeviceId } from './storage';

function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  // Unsigned hex, padded.
  return (h >>> 0).toString(16).padStart(8, '0');
}

export async function ensureDeviceId(): Promise<string> {
  const existing = await getDeviceId();
  if (existing) return existing;

  const parts = [
    Platform.OS,
    Device.modelId || Device.modelName || 'unknown',
    Device.osVersion || '0',
    Device.brand || '',
    // Fall back to a random nibble so two identical devices get distinct IDs.
    Math.random().toString(36).slice(2, 10),
  ].join('|');

  const id = `stf_${djb2(parts)}${Math.random().toString(36).slice(2, 6)}`;
  await setDeviceId(id);
  return id;
}
