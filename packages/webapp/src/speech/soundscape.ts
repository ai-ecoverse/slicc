import { playSoundscapeCue, type SoundscapeCue } from '@slicc/webcomponents/audio/soundscape-cues';
import { createLogger } from '../base/logger.js';

const log = createLogger('speech:soundscape');

export type { SoundscapeCue };

const STORAGE_KEY = 'soundscape-enabled';

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
  } catch {}
}

let voiceTurnDepth = 0;
let ttsActive = false;

export function beginVoiceTurn(): void {
  voiceTurnDepth++;
}

export function endVoiceTurn(): void {
  if (voiceTurnDepth > 0) voiceTurnDepth--;
}

export function isVoiceTurnActive(): boolean {
  return voiceTurnDepth > 0;
}

export function setTtsActive(active: boolean): void {
  ttsActive = active;
}

export function isTtsActive(): boolean {
  return ttsActive;
}

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

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

export function resetSoundscapeForTests(): void {
  voiceTurnDepth = 0;
  ttsActive = false;
  audioContext = null;
}
