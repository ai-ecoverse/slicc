import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { playSoundscapeCue, type SoundscapeCue } from './soundscape-cues.js';

const STYLE = `
:host {
  display: inline-grid;
  grid-auto-flow: column;
  gap: 8px;
  font-family: var(--ui);
  color: var(--ink);
}
:host([hidden]) { display: none; }
.cue {
  display: inline-grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--canvas);
  color: var(--txt-2);
  font-family: var(--ui);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
.cue:hover { background: var(--ghost); color: var(--ink); }
.cue:active { background: var(--ctx); color: var(--canvas); border-color: var(--ctx); }
.cue:disabled { cursor: default; opacity: 0.45; }
.cue:disabled:hover { background: var(--canvas); color: var(--txt-2); }
.glyph { display: grid; place-items: center; pointer-events: none; }
.glyph svg { display: block; }
.label { pointer-events: none; }
`;
const SHEET = sheet(STYLE);

interface CueButton {
  cue: SoundscapeCue;
  label: string;
  icon: string;
}

/** The three voice-mode cues, in the order they appear on the soundboard. */
const BUTTONS: readonly CueButton[] = [
  { cue: 'sent', label: 'Sent', icon: 'send' },
  { cue: 'tool-start', label: 'Tool start', icon: 'play' },
  { cue: 'tool-finish', label: 'Tool finish', icon: 'check' },
];

const ICON_SIZE = 14;

/**
 * `<slicc-soundboard>` — Storybook-only dev surface for the voice-mode
 * soundscape cues. Renders one labelled button per cue (`sent`, `tool-start`,
 * `tool-finish`); clicking a button lazily creates / resumes a single shared
 * `AudioContext` and plays the matching cue via {@link playSoundscapeCue}.
 *
 * The synthesis itself is identical to the webapp's voice-mode soundscape —
 * both consume the same `RECIPES` table from `./soundscape-cues.js`, so this
 * component is a faithful audition surface for those cues without dragging in
 * the webapp's three gates (enabled / voice-turn / TTS-active).
 *
 * Clicks produce real audio, which requires a user gesture; a real click in
 * Storybook (or a test) satisfies that.
 *
 * @csspart button - the inner `<button>` for each cue
 * @csspart icon - the lucide `<svg>` glyph
 * @csspart label - the cue's text label
 */
export class SliccSoundboard extends HTMLElement {
  readonly #root: ShadowRoot;
  /** Lazily created on the first click — needs a user gesture to be useful. */
  #ctx: AudioContext | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  /**
   * The shared AudioContext created on the first click. Exposed for tests so
   * they can assert lazy creation without poking at the shadow root.
   */
  get audioContext(): AudioContext | null {
    return this.#ctx;
  }

  #getOrCreateContext(): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null;
    if (!this.#ctx || this.#ctx.state === 'closed') {
      this.#ctx = new AudioContext();
    }
    return this.#ctx;
  }

  #playCue(cue: SoundscapeCue): void {
    const ctx = this.#getOrCreateContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    playSoundscapeCue(ctx, cue);
  }

  #render(): void {
    const buttons = BUTTONS.map(({ cue, label, icon }) => {
      const glyph = iconEl(icon, { size: ICON_SIZE, part: 'icon' });
      const button = h(
        'button',
        {
          type: 'button',
          class: 'cue',
          part: 'button',
          'data-cue': cue,
          'aria-label': `Play ${label} cue`,
          title: `Play ${label} cue`,
        },
        h('span', { class: 'glyph' }, glyph),
        h('span', { class: 'label', part: 'label' }, label)
      );
      button.addEventListener('click', () => this.#playCue(cue));
      return button;
    });
    this.#root.replaceChildren(...buttons);
  }
}

define('slicc-soundboard', SliccSoundboard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-soundboard': SliccSoundboard;
  }
}
