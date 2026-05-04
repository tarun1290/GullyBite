// Thin wrapper around expo-av's Audio.Sound for the new-order chime. The
// file is bundled from ./assets/sounds/new_order.mp3 — see the asset
// README for how to add / replace it. If the asset is missing we swallow
// the error so the rest of the flow keeps working.

import { Audio } from 'expo-av';

let cached: Audio.Sound | null = null;
let loading = false;

async function ensureLoaded(): Promise<Audio.Sound | null> {
  if (cached) return cached;
  if (loading) return null;
  loading = true;
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      // Keep the alarm ringing if staff minimizes the app before
      // accepting the order — matches the web dashboard's alarm
      // behavior. unloadChime() (called when the order is actioned)
      // is the only thing that stops it.
      staysActiveInBackground: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const asset = require('../assets/sounds/new_order.mp3');
    const { sound } = await Audio.Sound.createAsync(asset, { shouldPlay: false });
    cached = sound;
    return sound;
  } catch (err) {
    console.warn('[sound] load failed:', (err as Error).message);
    return null;
  } finally {
    loading = false;
  }
}

export async function playNewOrderChime(): Promise<void> {
  const sound = await ensureLoaded();
  if (!sound) return;
  try {
    await sound.setPositionAsync(0);
    // Loop until explicitly stopped via unloadChime() — the order
    // popup / accept-or-decline flow is what triggers that stop.
    // Set looping BEFORE play so the very first cycle already loops.
    await sound.setIsLoopingAsync(true);
    await sound.playAsync();
  } catch (err) {
    console.warn('[sound] play failed:', (err as Error).message);
  }
}

export async function unloadChime(): Promise<void> {
  if (cached) {
    // Stop first so unloadAsync doesn't tear down a still-playing
    // looped buffer — that path produces a brief audio glitch on
    // some Android devices. stopAsync rejects on an already-stopped
    // sound, so swallow.
    try { await cached.stopAsync(); } catch { /* noop */ }
    try { await cached.unloadAsync(); } catch { /* noop */ }
    cached = null;
  }
}
