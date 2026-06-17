import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccSoundboard } from '../../src/audio/slicc-soundboard.js';
import { RECIPES } from '../../src/audio/soundscape-cues.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

interface OscRecord {
  type: OscillatorType;
  freqStart: number;
  freqSlideTo: number | null;
  started: boolean;
  stopped: boolean;
}
interface CtxRecord {
  resumed: boolean;
  oscs: OscRecord[];
  created: number;
}

/** AudioContext stub that records every oscillator + resume the soundboard triggers. */
function stubAudioContext(initialState: AudioContextState = 'running'): CtxRecord {
  const rec: CtxRecord = { resumed: false, oscs: [], created: 0 };
  class FakeAudioContext {
    state: AudioContextState = initialState;
    currentTime = 0;
    destination = {};
    constructor() {
      rec.created += 1;
    }
    resume = () => {
      rec.resumed = true;
      this.state = 'running';
      return Promise.resolve();
    };
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
      const osc: OscRecord = {
        type: 'sine',
        freqStart: 0,
        freqSlideTo: null,
        started: false,
        stopped: false,
      };
      rec.oscs.push(osc);
      return {
        get type(): OscillatorType {
          return osc.type;
        },
        set type(v: OscillatorType) {
          osc.type = v;
        },
        frequency: {
          setValueAtTime: (v: number) => {
            osc.freqStart = v;
          },
          linearRampToValueAtTime: (v: number) => {
            osc.freqSlideTo = v;
          },
        },
        connect: vi.fn(),
        start: () => {
          osc.started = true;
        },
        stop: () => {
          osc.stopped = true;
        },
      };
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return rec;
}

function mount(): SliccSoundboard {
  const el = document.createElement('slicc-soundboard');
  document.body.appendChild(el);
  return el;
}

function buttons(el: SliccSoundboard): HTMLButtonElement[] {
  return [...(el.shadowRoot?.querySelectorAll('button.cue') ?? [])] as HTMLButtonElement[];
}

describe('slicc-soundboard', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-soundboard')).toBe(SliccSoundboard);
  });

  it('renders three labelled cue buttons in the documented order', () => {
    const el = mount();
    const btns = buttons(el);
    expect(btns).toHaveLength(3);
    expect(btns.map((b) => b.getAttribute('data-cue'))).toEqual([
      'sent',
      'tool-start',
      'tool-finish',
    ]);
    expect(btns.map((b) => b.querySelector('.label')?.textContent)).toEqual([
      'Sent',
      'Tool start',
      'Tool finish',
    ]);
  });

  it('renders a lucide <svg> glyph on each button — no emoji', () => {
    const el = mount();
    for (const btn of buttons(el)) {
      const svg = btn.querySelector('svg');
      expect(svg).toBeInstanceOf(SVGSVGElement);
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
    }
  });

  it('lazily creates the AudioContext only on the first click', () => {
    const ctx = stubAudioContext();
    const el = mount();
    expect(ctx.created).toBe(0);
    expect(el.audioContext).toBeNull();
    buttons(el)[0].click();
    expect(ctx.created).toBe(1);
    expect(el.audioContext).not.toBeNull();
    // Subsequent clicks reuse the same context — no second `new AudioContext()`.
    buttons(el)[1].click();
    buttons(el)[2].click();
    expect(ctx.created).toBe(1);
  });

  it('plays the matching cue on click — frequencies follow the recipes', () => {
    const ctx = stubAudioContext();
    const el = mount();
    buttons(el)[0].click(); // sent
    expect(ctx.oscs).toHaveLength(1);
    expect(ctx.oscs[0].freqStart).toBe(RECIPES.sent.freq);
    expect(ctx.oscs[0].freqSlideTo).toBe(RECIPES.sent.freqSlideTo);
    expect(ctx.oscs[0].type).toBe(RECIPES.sent.type);

    buttons(el)[1].click(); // tool-start: two oscillators
    expect(ctx.oscs).toHaveLength(3);
    expect(ctx.oscs[1].freqStart).toBe(RECIPES['tool-start'].freq);
    expect(ctx.oscs[2].freqStart).toBe(RECIPES['tool-start'].freq2);

    buttons(el)[2].click(); // tool-finish: two oscillators
    expect(ctx.oscs).toHaveLength(5);
    expect(ctx.oscs[3].freqStart).toBe(RECIPES['tool-finish'].freq);
    expect(ctx.oscs[4].freqStart).toBe(RECIPES['tool-finish'].freq2);

    // Every oscillator must be started AND scheduled to stop (no leaks).
    for (const o of ctx.oscs) {
      expect(o.started).toBe(true);
      expect(o.stopped).toBe(true);
    }
  });

  it('resumes a suspended AudioContext on the click that revives it', () => {
    const ctx = stubAudioContext('suspended');
    const el = mount();
    buttons(el)[0].click();
    expect(ctx.resumed).toBe(true);
    expect(ctx.oscs.length).toBeGreaterThan(0);
  });

  it('is a silent no-op when AudioContext is unavailable in the realm', () => {
    vi.stubGlobal('AudioContext', undefined);
    const el = mount();
    expect(() => buttons(el)[0].click()).not.toThrow();
    expect(el.audioContext).toBeNull();
  });
});
