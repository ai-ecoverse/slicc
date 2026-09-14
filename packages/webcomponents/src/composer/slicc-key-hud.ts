import { define } from '../internal/define.js';
import { append, type HChild, h, sheet } from '../internal/dom.js';
import { hasIcon, iconEl } from '../internal/icons.js';
import { CAP_ICONS } from '../internal/key-caps.js';

export interface KeyPress {
  caps: string[];

  bound?: boolean;
}

const PREFIX = 'slicc-key-hud';

const DEFAULT_DEPTH = 4;

const DEFAULT_LINGER_MS = 1600;

const DEFAULT_HINT = '[?] help · [i] or [⏎] to type';

function capNode(text: string, hint: boolean): HTMLElement {
  const icon = CAP_ICONS[text];
  const cap = h('kbd', {
    class: hint ? 'cap cap-hint' : 'cap',
    part: 'cap',

    ...(icon ? { 'aria-label': text } : {}),
  });
  if (icon && hasIcon(icon)) cap.append(iconEl(icon, { size: hint ? 11 : 12, strokeWidth: 2.2 }));
  else cap.textContent = text;
  return cap;
}

export function hintNodes(hint: string): HChild[] {
  return hint
    .split(/(\[[^\]]+\])/)
    .filter((part) => part !== '')
    .map((part) =>
      part.startsWith('[') && part.endsWith(']') ? capNode(part.slice(1, -1), true) : part
    );
}

const STYLE = `
:host{display:block;font-family:var(--ui);color:var(--ink);}
:host([hidden]){display:none;}
.hud{display:flex;align-items:center;gap:8px;font:600 11.5px/1 var(--ui);}
.icon{flex:0 0 auto;color:var(--ctx,var(--waffle,#e6a03c));}
.label{white-space:nowrap;}
.hint{color:var(--txt-3);font-weight:500;white-space:nowrap;}
/* A cap in the hint NAMES a key rather than reporting one, so it wears the
   same chrome one step quieter — no bottom lip, no ink. */
.cap-hint{margin:0 1px;padding:3px 5px;font-size:11px;color:var(--txt-2);border-bottom-width:1px;vertical-align:middle;}
.hint[hidden]{display:none;}
.keys{display:none;align-items:center;gap:5px;}
.keys:not(:empty){display:flex;}
.press{display:flex;align-items:center;gap:2px;}
.cap{display:inline-flex;align-items:center;justify-content:center;min-width:20px;padding:3px 6px;border-radius:5px;text-align:center;font:600 12px/1 var(--mono,ui-monospace,monospace);color:var(--ink);background:var(--ghost);border:1px solid var(--line);border-bottom-width:2px;}
.press[data-bound='false'] .cap{color:var(--txt-3);opacity:.55;border-bottom-width:1px;}
.press[data-age='stale'] .cap{opacity:.4;}
.press[data-age='stale'][data-bound='false'] .cap{opacity:.25;}

/* One line of chrome pinned to the BOTTOM of whatever positioned column hosts
   it — the chat pane, where it lands on the composer band's bottom edge, over
   the meta row (the chrome you need least while driving from the keyboard) and
   leaves the draft, the toolbar and the send button on screen.

   Pinned to the COLUMN rather than to the band because a read-only scoop hides
   its composer entirely (#2312): anchored to the band, the mode would lose its
   only sign of life exactly where the keyboard is all you have.

   The height is FIXED, so the resting hint and a run of key caps are the same
   bar: it is up for as long as the mode is, and one that grew a few pixels on
   every keystroke would twitch under the composer all session.

   z-index 2 matches the composer band so the bar sits on the meta row. The
   rightward bleed is NOT here: it lives as a .slicc-shell rule next to the
   composer's own ::before (slicc-composer.ts), because only that layout
   has tool tiles at z-index 3 to float above it. Under panel-layouts the
   chat and tool surfaces are sibling slicc-panels with no such wrapper,
   and an unconditional 100vw bleed would tint the adjacent panel. */
:host{position:absolute;left:0;right:0;bottom:0;z-index:2;box-sizing:border-box;overflow:visible;height:34px;background:color-mix(in srgb,var(--ctx) 12%,color-mix(in srgb,var(--bg) 88%,transparent));border-top:1px solid color-mix(in srgb,var(--ctx) 28%,var(--line));backdrop-filter:blur(8px) saturate(1.3);-webkit-backdrop-filter:blur(8px) saturate(1.3);}
.hud{justify-content:space-between;height:34px;padding:0 16px;}
/* The name and the hint read as one phrase on the left; the caps answer from
   the right, where they land in the same place every time instead of shunting
   the phrase sideways as the strip grows. */
.hint{flex:1 1 auto;}
.keys{margin-left:auto;}

@media (prefers-reduced-motion:no-preference){
  .pressanimation:$PREFIX-press-in .12s ease-out;
  .hudanimation:$PREFIX-band-in .14s ease-out;
}
@keyframes ${PREFIX}-press-in{from{opacity:0;transform:translateY(2px) scale(.94);}to{opacity:1;transform:none;}}
@keyframes ${PREFIX}-band-in{from{opacity:0;}to{opacity:1;}}
`;

const SHEET = sheet(STYLE);

export class SliccKeyHud extends HTMLElement {
  static readonly observedAttributes = ['label', 'hint'];

  readonly #root: ShadowRoot;
  #presses: KeyPress[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;

  #deadline: number | null = null;
  #hudEl: HTMLElement | null = null;
  #labelEl: HTMLElement | null = null;
  #hintEl: HTMLElement | null = null;
  #keysEl: HTMLElement | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
    if (!this.hasAttribute('aria-live')) this.setAttribute('aria-live', 'polite');
    this.#render();
    this.#resume();
  }

  disconnectedCallback(): void {
    this.#stopTimer();
  }

  attributeChangedCallback(): void {
    if (this.#hudEl) this.#reflect();
  }

  get label(): string {
    return this.getAttribute('label') ?? 'Keyboard mode';
  }

  set label(value: string) {
    this.setAttribute('label', value);
  }

  get hint(): string {
    return this.getAttribute('hint') ?? DEFAULT_HINT;
  }

  set hint(value: string) {
    this.setAttribute('hint', value);
  }

  get depth(): number {
    const raw = Number.parseInt(this.getAttribute('depth') ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEPTH;
  }

  set depth(value: number) {
    this.setAttribute('depth', String(value));
  }

  get linger(): number {
    const raw = Number.parseInt(this.getAttribute('linger') ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LINGER_MS;
  }

  set linger(value: number) {
    this.setAttribute('linger', String(value));
  }

  get presses(): KeyPress[] {
    return this.#presses.map((press) => ({ ...press, caps: [...press.caps] }));
  }

  set presses(value: KeyPress[]) {
    this.#presses = (Array.isArray(value) ? value : [])
      .filter((press) => Array.isArray(press?.caps))
      .map((press) => ({ bound: press.bound !== false, caps: [...press.caps] }));
    this.#stopTimer();
    this.#deadline = null;
    this.#trim();
    this.#reflect();
  }

  record(caps: readonly string[], bound = true): void {
    this.#presses.push({ caps: [...caps], bound });
    this.#trim();
    this.#reflect();
    this.#arm(this.linger);
  }

  clear(): void {
    this.#stopTimer();
    this.#deadline = null;
    this.#presses = [];
    this.#reflect();
  }

  #arm(ms: number): void {
    this.#stopTimer();
    this.#deadline = Date.now() + ms;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.clear();
    }, ms);
  }

  #resume(): void {
    if (this.#deadline === null || this.#presses.length === 0) return;
    const left = this.#deadline - Date.now();
    if (left <= 0) this.clear();
    else this.#arm(left);
  }

  #stopTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #trim(): void {
    const excess = this.#presses.length - this.depth;
    if (excess > 0) this.#presses.splice(0, excess);
  }

  #render(): void {
    this.#labelEl = h('span', { class: 'label', part: 'label' });
    this.#hintEl = h('span', { class: 'hint', part: 'hint' });
    this.#keysEl = h('div', { class: 'keys', part: 'keys', 'aria-hidden': 'true' });
    this.#hudEl = h(
      'div',
      { class: 'hud', part: 'hud' },
      iconEl('keyboard', { size: 15, strokeWidth: 1.9, class: 'icon', part: 'icon' }),
      this.#labelEl,
      this.#hintEl,
      this.#keysEl
    );
    this.#root.replaceChildren(this.#hudEl);
    this.#reflect();
  }

  #reflect(): void {
    if (!this.#labelEl || !this.#hintEl || !this.#keysEl) return;
    this.#labelEl.textContent = this.label;
    this.#hintEl.replaceChildren();
    append(this.#hintEl, hintNodes(this.hint));

    this.#hintEl.hidden = this.hint === '' || this.#presses.length > 0;
    this.#keysEl.replaceChildren(
      ...this.#presses.map((press, index) =>
        h(
          'span',
          {
            class: 'press',
            'data-bound': String(press.bound !== false),

            ...(index < this.#presses.length - 1 ? { 'data-age': 'stale' } : {}),
          },
          ...press.caps.map((cap) => capNode(cap, false))
        )
      )
    );
  }
}

define(PREFIX, SliccKeyHud);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-key-hud': SliccKeyHud;
  }
}
