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

import { createLogger } from '../core/logger.js';

const log = createLogger('speech:soundscape');

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

export type SoundscapeCue = 'sent' | 'tool-start' | 'tool-finish';

/**
 * Per-cue tone recipe. Two oscillators are summed (the second is optional for
 * a richer chord) and shaped by an exponential gain envelope. Frequencies were
 * picked to sit ABOVE typical speech (so they don't mask the spoken reply
 * even if ducking briefly misses) and below ~2 kHz so they don't pierce.
 */
interface CueRecipe {
  /** Primary oscillator frequency (Hz). */
  freq: number;
  /** Optional second oscillator for a chord (Hz). */
  freq2?: number;
  /** Frequency slide target on the primary osc (Hz, linear over `duration`). */
  freqSlideTo?: number;
  /** Cue duration in seconds (kept short — these cues are jabs, not drones). */
  duration: number;
  /** Peak gain — quiet on purpose so cues don't startle. */
  peakGain: number;
  /** Oscillator waveform — sine is gentlest; triangle has more presence. */
  type: OscillatorType;
}

const RECIPES: Readonly<Record<SoundscapeCue, CueRecipe>> = {
  // Rising chirp — "off you go".
  sent: { freq: 660, freqSlideTo: 990, duration: 0.12, peakGain: 0.06, type: 'sine' },
  // Low double-tone — "starting".
  'tool-start': { freq: 520, freq2: 780, duration: 0.07, peakGain: 0.04, type: 'triangle' },
  // Higher double-tone — "done".
  'tool-finish': { freq: 880, freq2: 1320, duration: 0.07, peakGain: 0.04, type: 'sine' },
};

/**
 * Play a cue if all three gates allow it. The call is fire-and-forget —
 * synthesis failures log at debug level and never throw (cue audio is purely
 * informational; a missing AudioContext or a suspended realm must not break
 * the chat flow).
 */
export function playCue(cue: SoundscapeCue): void {
  if (!getSoundscapeEnabled()) return;
  if (!isVoiceTurnActive()) return;
  if (isTtsActive()) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const recipe = RECIPES[cue];
    const now = ctx.currentTime;
    const end = now + recipe.duration;
    const gain = ctx.createGain();
    // Exponential ramp from a tiny floor to peak then back — clicks-free
    // attack and release, no DC step that pops the speakers.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(recipe.peakGain, now + recipe.duration * 0.2);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    gain.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = recipe.type;
    osc1.frequency.setValueAtTime(recipe.freq, now);
    if (recipe.freqSlideTo !== undefined) {
      osc1.frequency.linearRampToValueAtTime(recipe.freqSlideTo, end);
    }
    osc1.connect(gain);
    osc1.start(now);
    osc1.stop(end);

    if (recipe.freq2 !== undefined) {
      const osc2 = ctx.createOscillator();
      osc2.type = recipe.type;
      osc2.frequency.setValueAtTime(recipe.freq2, now);
      osc2.connect(gain);
      osc2.start(now);
      osc2.stop(end);
    }
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
