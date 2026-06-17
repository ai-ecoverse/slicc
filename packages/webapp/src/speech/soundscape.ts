/**
 * Audible soundscape for voice-mode activity (#1036).
 *
 * Short, subtle WebAudio cues that play during a voice-initiated turn so the
 * user gets audible progress while SLICC works silently between the dictated
 * submit and the spoken reply. Three cues:
 *
 *  - **sent** — user message submitted by push-to-talk dictation.
 *  - **tool-start** — the agent invoked a tool / shell command.
 *  - **tool-finish** — that tool / command returned.
 *
 * Cues are SYNTHESIZED with oscillators + an exponential gain envelope — no
 * audio assets are bundled (mirrors the `AudioContext`/`playPcm` pattern in
 * `speak.ts`).
 *
 * Three gates compose before a cue actually plays:
 *  1. **enabled** — persisted boolean (`localStorage`, default `true`).
 *  2. **voice-turn-active** — `beginVoiceTurn()` / `endVoiceTurn()` window;
 *     typed turns stay silent.
 *  3. **TTS-not-active** — `setTtsActive(true)` while the spoken reply plays;
 *     cues are suppressed so they can't clash with the readout.
 */

import { playSoundscapeCue, type SoundscapeCue } from '@slicc/webcomponents/audio/soundscape-cues';
import { createLogger } from '../core/logger.js';

const log = createLogger('speech:soundscape');

// Re-export the cue type so existing consumers (`SoundscapeCue` imports from
// this module) keep working after the recipes moved to the shared library.
export type { SoundscapeCue };

const STORAGE_KEY = 'soundscape-enabled';

/** Persisted enable flag (default on). The setting gates ALL cue playback. */
export function getSoundscapeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setSoundscapeEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // No-op: in a realm without storage the in-memory default takes over.
  }
}

let voiceTurnDepth = 0;
let ttsActive = false;

/** Open the voice-mode window — cues only play while this is positive. */
export function beginVoiceTurn(): void {
  voiceTurnDepth++;
}

/** Close one voice-mode window opened by {@link beginVoiceTurn}. */
export function endVoiceTurn(): void {
  if (voiceTurnDepth > 0) voiceTurnDepth--;
}

export function isVoiceTurnActive(): boolean {
  return voiceTurnDepth > 0;
}

/**
 * Flip the TTS-active flag — while true, cues are suppressed so the spoken
 * reply readout plays clean. Callers wrap the `speak()` invocation:
 * `setTtsActive(true); try { await speak(...) } finally { setTtsActive(false) }`.
 */
export function setTtsActive(active: boolean): void {
  ttsActive = active;
}

export function isTtsActive(): boolean {
  return ttsActive;
}

/** One lazily-created context per realm, mirroring `speak.ts`. */
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/**
 * Play a cue if all three gates allow it. The call is fire-and-forget —
 * synthesis failures log at debug level and never throw (cue audio is purely
 * informational; a missing AudioContext or a suspended realm must not break
 * the chat flow). The actual oscillator+envelope synthesis lives in
 * `@slicc/webcomponents/audio/soundscape-cues` (shared with the Storybook
 * `<slicc-soundboard>`); only the gates and the AudioContext singleton stay
 * here — the recipes are byte-for-byte identical.
 */
export function playCue(cue: SoundscapeCue): void {
  if (!getSoundscapeEnabled()) return;
  if (!isVoiceTurnActive()) return;
  if (isTtsActive()) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    playSoundscapeCue(ctx, cue);
  } catch (err) {
    log.debug('soundscape cue failed', err);
  }
}

/** Test-only: reset all module-level state so each test starts clean. */
export function resetSoundscapeForTests(): void {
  voiceTurnDepth = 0;
  ttsActive = false;
  audioContext = null;
}
