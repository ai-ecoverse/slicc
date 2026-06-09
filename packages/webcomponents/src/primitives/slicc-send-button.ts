import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

const STYLE = `
:host { display: inline-flex; }
:host([hidden]) { display: none; }

.send {
  width: 36px;
  height: 36px;
  border-radius: 9999px;
  border: none;
  cursor: pointer;
  background: var(--rainbow);
  color: #fff;
  font-size: 16px;
  font-family: var(--ui);
  display: grid;
  place-items: center;
  padding: 0;
  line-height: 1;
}
.send:hover:not(:disabled) { filter: brightness(1.06); }
.send:disabled { cursor: not-allowed; opacity: 0.45; }

/* Busy/streaming: white stop square sized to read inside the 36px circle. */
.send.is-busy { font-size: 0; }
.glyph { pointer-events: none; }
.stop {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  background: #fff;
  pointer-events: none;
}
`;

/**
 * `<slicc-send-button>` — the composer toolbar send control from the prototype
 * (`.send`): a 36px circular button filled with the brand `--rainbow` gradient
 * and a white `↑` glyph. Self-contained shadow DOM; themes via inherited tokens
 * (`--rainbow` is theme-independent and the white glyph reads in light + dark).
 *
 * States:
 * - default — clickable, emits `send`.
 * - `disabled` — non-interactive (e.g. empty composer input); emits nothing.
 * - `busy` — streaming; shows a white stop `■` and emits `stop` on click.
 *
 * @attr disabled - boolean; non-interactive, dimmed.
 * @attr busy - boolean; streaming state — renders a stop glyph and emits `stop`.
 * @attr label - accessible label / tooltip (defaults to "Send" / "Stop").
 * @fires send - composed + bubbling; on click when not `busy` and not `disabled`.
 * @fires stop - composed + bubbling; on click when `busy` and not `disabled`.
 * @csspart button - the circular <button> element.
 * @csspart glyph - the up-arrow glyph wrapper (default state).
 * @csspart stop - the stop square (busy state).
 * @slot - optional custom default glyph (replaces the `↑`).
 * @slot busy - optional custom busy glyph (replaces the stop square).
 */
export class SliccSendButton extends HTMLElement {
  static readonly observedAttributes = ['disabled', 'busy', 'label'];

  readonly #root: ShadowRoot;
  #button: HTMLButtonElement | null = null;

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

  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(value: boolean) {
    this.toggleAttribute('disabled', Boolean(value));
  }

  get busy(): boolean {
    return this.hasAttribute('busy');
  }

  set busy(value: boolean) {
    this.toggleAttribute('busy', Boolean(value));
  }

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #onClick = (): void => {
    if (this.disabled) return;
    const type = this.busy ? 'stop' : 'send';
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
  };

  #render(): void {
    const busy = this.busy;
    const disabled = this.disabled;
    const label = escapeHtml(this.label ?? (busy ? 'Stop' : 'Send'));
    const inner = busy
      ? '<slot name="busy"><span class="stop" part="stop"></span></slot>'
      : '<slot><span class="glyph" part="glyph">↑</span></slot>';

    this.#root.innerHTML = `<style>${STYLE}</style><button
      part="button"
      class="send${busy ? ' is-busy' : ''}"
      type="button"
      title="${label}"
      aria-label="${label}"
      ${disabled ? 'disabled' : ''}
    >${inner}</button>`;

    this.#button = this.#root.querySelector('button');
    this.#button?.addEventListener('click', this.#onClick);
  }
}

define('slicc-send-button', SliccSendButton);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-send-button': SliccSendButton;
  }
}
