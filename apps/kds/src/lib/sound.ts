import { useSyncExternalStore } from 'react';

/**
 * New-ticket beep via WebAudio (no audio files to load or cache).
 *
 * Browsers keep an AudioContext suspended until a user gesture, so sound can only be turned
 * on from a tap (enableSound). `running` reflects what the browser really allows, which is
 * what the UI shows, not merely what the user asked for.
 */
let ctx: AudioContext | null = null;
let running = false;
const listeners = new Set<() => void>();

function sync(): void {
  const next = ctx?.state === 'running';
  if (next === running) return;
  running = next;
  listeners.forEach((l) => l());
}

export const soundSupported = (): boolean => typeof AudioContext !== 'undefined';

/** Must be called from a click/tap handler. Resolves to whether audio can really play now. */
export async function enableSound(): Promise<boolean> {
  if (!soundSupported()) return false;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      ctx.onstatechange = sync; // the OS or browser may suspend audio again later
    }
    await ctx.resume();
  } catch {
    // Leave it off; the UI reports the real state.
  }
  sync();
  return running;
}

export async function disableSound(): Promise<void> {
  await ctx?.suspend().catch(() => undefined);
  sync();
}

/** Short two-tone alert, repeated so it cuts through extractor-fan noise. No-op while muted. */
export function beep(repeats = 2): void {
  if (!ctx || ctx.state !== 'running') return;
  const start = ctx.currentTime;
  for (let i = 0; i < repeats * 2; i++) {
    const at = start + i * 0.22;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = i % 2 === 0 ? 880 : 1175;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.2);
  }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** True while the browser is actually able to play the alert. */
export function useSoundRunning(): boolean {
  return useSyncExternalStore(subscribe, () => running, () => false);
}
