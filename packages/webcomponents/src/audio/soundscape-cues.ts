export type SoundscapeCue = 'sent' | 'tool-start' | 'tool-finish';

export interface CueRecipe {
  freq: number;

  freq2?: number;

  freqSlideTo?: number;

  duration: number;

  peakGain: number;

  type: OscillatorType;
}

export const RECIPES: Readonly<Record<SoundscapeCue, CueRecipe>> = {
  sent: { freq: 660, freqSlideTo: 990, duration: 0.12, peakGain: 0.06, type: 'sine' },

  'tool-start': { freq: 520, freq2: 780, duration: 0.07, peakGain: 0.04, type: 'triangle' },

  'tool-finish': { freq: 880, freq2: 1320, duration: 0.07, peakGain: 0.04, type: 'sine' },
};

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
