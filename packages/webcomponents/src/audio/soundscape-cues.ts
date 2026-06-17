/**
 * Pure soundscape cue recipes + oscillator synthesis — the single source of
 * truth shared by the webapp's voice-mode soundscape (`speech/soundscape.ts`)
 * and the `<slicc-soundboard>` Storybook component.
 *
 * No logger, no gating, no localStorage — just the WebAudio primitives. Each
 * cue sums one or two oscillators through an exponential gain envelope; the
 * exact frequencies / durations / gains / waveforms are byte-for-byte the
 * recipes from the original webapp module (#1036).
 *
 * Callers own the `AudioContext` and any policy (enabled / voice-turn / TTS
 * suppression / resume-on-gesture). This module only synthesizes when asked.
 */

/** The three voice-mode cues. */
export type SoundscapeCue = 'sent' | 'tool-start' | 'tool-finish';

/**
 * Per-cue tone recipe. Two oscillators are summed (the second is optional for
 * a richer chord) and shaped by an exponential gain envelope. Frequencies were
 * picked to sit ABOVE typical speech (so they don't mask the spoken reply
 * even if ducking briefly misses) and below ~2 kHz so they don't pierce.
 */
export interface CueRecipe {
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

export const RECIPES: Readonly<Record<SoundscapeCue, CueRecipe>> = {
  // Rising chirp — "off you go".
  sent: { freq: 660, freqSlideTo: 990, duration: 0.12, peakGain: 0.06, type: 'sine' },
  // Low double-tone — "starting".
  'tool-start': { freq: 520, freq2: 780, duration: 0.07, peakGain: 0.04, type: 'triangle' },
  // Higher double-tone — "done".
  'tool-finish': { freq: 880, freq2: 1320, duration: 0.07, peakGain: 0.04, type: 'sine' },
};

/**
 * Synthesize one cue on the given AudioContext. Pure: no gates, no logger,
 * no try/catch. The caller decides whether to play, owns the context, and is
 * responsible for resuming a suspended context on a user gesture.
 *
 * The envelope is an exponential ramp from a tiny floor to peak then back —
 * clicks-free attack and release, no DC step that pops the speakers.
 */
export function playSoundscapeCue(ctx: AudioContext, cue: SoundscapeCue): void {
  const recipe = RECIPES[cue];
  const now = ctx.currentTime;
  const end = now + recipe.duration;
  const gain = ctx.createGain();
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
}
