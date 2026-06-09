import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

const DEFAULT_LABEL = 'CLI float';

const STYLE = `
:host {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  box-sizing: border-box;
  height: var(--ctl-h, 30px);
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 9999px;
  background: var(--canvas);
  color: var(--txt-2);
  font-family: var(--ui);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}
:host([hidden]) { display: none; }

/* linked → rose-tinted border (mixes --rose into --line) */
:host([linked]) {
  border-color: color-mix(in srgb, var(--rose) 40%, var(--line));
}

.fdot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 22%, transparent);
}

.label { white-space: nowrap; }
`;

/**
 * `<slicc-floatbar>` — the Runtime Float Pill from the prototype nav
 * (`.floatbar`). An inline-flex rounded pill carrying a status dot (`.fdot`)
 * and a runtime label such as `CLI · tray · 1 follower`. Self-contained shadow
 * DOM; themes via inherited tokens (--canvas, --line, --txt-2, --rose, --ui,
 * --ctl-h). The green status dot and the linked rose tint are fixed across
 * light/dark.
 *
 * @attr label - the runtime label text (defaults to "CLI float")
 * @attr linked - boolean; rose-tints the border to signal a linked runtime
 * @attr online - boolean; shows the green status dot
 * @csspart dot - the green status dot (present only when `online`)
 * @csspart label - the runtime label span
 * @slot - default slot overrides the label text
 */
export class SliccFloatbar extends HTMLElement {
  static readonly observedAttributes = ['label', 'linked', 'online'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** Runtime label text. Falls back to "CLI float" when unset. */
  get label(): string {
    return this.getAttribute('label') ?? DEFAULT_LABEL;
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Whether the runtime is linked (rose-tinted border). */
  get linked(): boolean {
    return this.hasAttribute('linked');
  }

  set linked(value: boolean) {
    this.toggleAttribute('linked', !!value);
  }

  /** Whether the status dot is shown (online/green). */
  get online(): boolean {
    return this.hasAttribute('online');
  }

  set online(value: boolean) {
    this.toggleAttribute('online', !!value);
  }

  #render(): void {
    const dotHtml = this.online ? '<span class="fdot" part="dot"></span>' : '';
    const label = escapeHtml(this.label);
    this.#root.innerHTML = `<style>${STYLE}</style>${dotHtml}<span class="label" part="label"><slot>${label}</slot></span>`;
  }
}

define('slicc-floatbar', SliccFloatbar);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-floatbar': SliccFloatbar;
  }
}
