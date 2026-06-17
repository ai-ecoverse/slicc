import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// localStorage shim for the Node test environment — mirrors the pattern in
// tests/ui/voice-input.test.ts.
const lsStore: Record<string, string> = {};
const localStorageShim = {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => {
    lsStore[k] = v;
  },
  removeItem: (k: string) => {
    delete lsStore[k];
  },
  clear: () => {
    for (const k of Object.keys(lsStore)) delete lsStore[k];
  },
};

interface OscRecord {
  type: OscillatorType;
  freqStart: number;
  freqSlideTo: number | null;
  started: boolean;
  stopped: boolean;
}
interface CtxRecord {
  state: AudioContextState;
  resumed: boolean;
  gainRamps: Array<{ when: 'attack' | 'release'; target: number }>;
  oscs: OscRecord[];
}

/** AudioContext stub recording every oscillator + gain ramp the cue dispatches. */
function stubAudioContext(): CtxRecord {
  const ctxRec: CtxRecord = { state: 'running', resumed: false, gainRamps: [], oscs: [] };
  class FakeAudioContext {
    state: AudioContextState = ctxRec.state;
    currentTime = 0;
    destination = {};
    resume = () => {
      ctxRec.resumed = true;
      return Promise.resolve();
    };
    createGain() {
      return {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: (target: number, when: number) => {
            // First ramp is the attack, second is the release.
            ctxRec.gainRamps.push({
              when: ctxRec.gainRamps.length === 0 ? 'attack' : 'release',
              target,
            });
            void when;
          },
        },
        connect: vi.fn(),
      };
    }
    createOscillator() {
      const rec: OscRecord = {
        type: 'sine',
        freqStart: 0,
        freqSlideTo: null,
        started: false,
        stopped: false,
      };
      ctxRec.oscs.push(rec);
      return {
        get type(): OscillatorType {
          return rec.type;
        },
        set type(v: OscillatorType) {
          rec.type = v;
        },
        frequency: {
          setValueAtTime: (v: number) => {
            rec.freqStart = v;
          },
          linearRampToValueAtTime: (v: number) => {
            rec.freqSlideTo = v;
          },
        },
        connect: vi.fn(),
        start: () => {
          rec.started = true;
        },
        stop: () => {
          rec.stopped = true;
        },
      };
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return ctxRec;
}

beforeEach(async () => {
  for (const k of Object.keys(lsStore)) delete lsStore[k];
  vi.stubGlobal('localStorage', localStorageShim);
  const mod = await import('../../src/speech/soundscape.js');
  mod.resetSoundscapeForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('soundscape settings', () => {
  it('enabled defaults to true and persists when toggled', async () => {
    const { getSoundscapeEnabled, setSoundscapeEnabled } = await import(
      '../../src/speech/soundscape.js'
    );
    expect(getSoundscapeEnabled()).toBe(true);
    setSoundscapeEnabled(false);
    expect(getSoundscapeEnabled()).toBe(false);
    setSoundscapeEnabled(true);
    expect(getSoundscapeEnabled()).toBe(true);
  });
});

describe('soundscape playCue gating', () => {
  it('does NOT play when disabled, even inside a voice turn', async () => {
    const ctx = stubAudioContext();
    const { beginVoiceTurn, playCue, setSoundscapeEnabled } = await import(
      '../../src/speech/soundscape.js'
    );
    setSoundscapeEnabled(false);
    beginVoiceTurn();
    playCue('sent');
    expect(ctx.oscs.length).toBe(0);
  });

  it('does NOT play when no voice turn is active (typed turns stay silent)', async () => {
    const ctx = stubAudioContext();
    const { playCue } = await import('../../src/speech/soundscape.js');
    playCue('sent');
    playCue('tool-start');
    playCue('tool-finish');
    expect(ctx.oscs.length).toBe(0);
  });

  it('does NOT play while TTS is active (no clash with the readout)', async () => {
    const ctx = stubAudioContext();
    const { beginVoiceTurn, playCue, setTtsActive } = await import(
      '../../src/speech/soundscape.js'
    );
    beginVoiceTurn();
    setTtsActive(true);
    playCue('tool-start');
    expect(ctx.oscs.length).toBe(0);
    // Releasing TTS lets the next cue through.
    setTtsActive(false);
    playCue('tool-finish');
    expect(ctx.oscs.length).toBeGreaterThan(0);
  });

  it('plays each cue when enabled + voice-turn active + TTS idle', async () => {
    const ctx = stubAudioContext();
    const { beginVoiceTurn, playCue } = await import('../../src/speech/soundscape.js');
    beginVoiceTurn();
    playCue('sent');
    const sentOscCount = ctx.oscs.length;
    expect(sentOscCount).toBeGreaterThan(0); // primary oscillator at minimum
    // The sent cue slides its primary oscillator (rising chirp).
    expect(ctx.oscs[0].freqSlideTo).not.toBeNull();
    playCue('tool-start');
    playCue('tool-finish');
    // Two-oscillator chord recipes for both tool cues — at least 2 more each.
    expect(ctx.oscs.length).toBeGreaterThanOrEqual(sentOscCount + 4);
    // Every oscillator must be started AND scheduled to stop (no leaks).
    for (const o of ctx.oscs) {
      expect(o.started).toBe(true);
      expect(o.stopped).toBe(true);
    }
  });

  it('resumes a suspended AudioContext before scheduling the cue', async () => {
    const ctx = stubAudioContext();
    ctx.state = 'suspended';
    // Re-stub with the suspended initial state so getAudioContext picks it up.
    class Suspended {
      state: AudioContextState = 'suspended';
      currentTime = 0;
      destination = {};
      resume() {
        ctx.resumed = true;
        return Promise.resolve();
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        };
      }
      createOscillator() {
        const rec: OscRecord = {
          type: 'sine',
          freqStart: 0,
          freqSlideTo: null,
          started: false,
          stopped: false,
        };
        ctx.oscs.push(rec);
        return {
          type: 'sine' as OscillatorType,
          frequency: {
            setValueAtTime: () => undefined,
            linearRampToValueAtTime: () => undefined,
          },
          connect: vi.fn(),
          start: () => {
            rec.started = true;
          },
          stop: () => {
            rec.stopped = true;
          },
        };
      }
    }
    vi.stubGlobal('AudioContext', Suspended);
    const { beginVoiceTurn, playCue, resetSoundscapeForTests } = await import(
      '../../src/speech/soundscape.js'
    );
    resetSoundscapeForTests();
    beginVoiceTurn();
    playCue('sent');
    expect(ctx.resumed).toBe(true);
  });
});

describe('soundscape voice-turn window', () => {
  it('endVoiceTurn closes the window; later cues are suppressed', async () => {
    const ctx = stubAudioContext();
    const { beginVoiceTurn, endVoiceTurn, playCue, isVoiceTurnActive } = await import(
      '../../src/speech/soundscape.js'
    );
    beginVoiceTurn();
    expect(isVoiceTurnActive()).toBe(true);
    playCue('tool-start');
    const during = ctx.oscs.length;
    endVoiceTurn();
    expect(isVoiceTurnActive()).toBe(false);
    playCue('tool-finish');
    expect(ctx.oscs.length).toBe(during); // no new oscillators
  });

  it('endVoiceTurn never goes negative (defensive)', async () => {
    const { endVoiceTurn, isVoiceTurnActive } = await import('../../src/speech/soundscape.js');
    endVoiceTurn();
    endVoiceTurn();
    expect(isVoiceTurnActive()).toBe(false);
  });

  it('no AudioContext in the realm → playCue is a silent no-op (does not throw)', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const { beginVoiceTurn, playCue } = await import('../../src/speech/soundscape.js');
    beginVoiceTurn();
    expect(() => playCue('sent')).not.toThrow();
  });
});
