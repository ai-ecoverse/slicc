import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * `<slicc-error-card>` — the **cone error card** rendered in the chat stream
 * when an agent turn fails. Mirrors the `slicc-lick-card` shape (rounded
 * card, iconed header, body line) but in the red/destructive palette and with
 * a trailing "Try again" affordance. It is presentational only: clicking the
 * button dispatches a bubbling, composed `slicc-error-retry` CustomEvent the
 * host (the chat controller) catches to re-run the last user turn through its
 * existing send path. The card itself never talks to the agent.
 *
 * Self-contained shadow DOM; themes via inherited tokens (`--red`, `--line`,
 * `--canvas`, `--ink`, `--ui`, `--txt-2`). Dark mode flips through the
 * library's `.dark` / `[data-theme="dark"]` / `body.dark` scopes (or the
 * per-element `theme` attribute), re-mixing the red tint over `--canvas` so
 * the card reads on a dark ground.
 *
 * Set the body via the `message` attribute (escaped plain text) or project
 * content into the default slot for rich markup.
 *
 * @attr label - the header label (default "Something went wrong")
 * @attr message - error body text (escaped); ignored when slotted content is present
 * @attr button-label - retry button label (default "Try again")
 * @attr theme - `light` | `dark`; per-element override of the inherited theme
 * @csspart card - the outer `.err` card
 * @csspart header - the `.eh` header row
 * @csspart icon - the `.ic` span wrapping the lucide `triangle-alert` `<svg>`
 * @csspart label - the header label span
 * @csspart body - the `.eb` body line
 * @csspart button - the retry button
 * @slot - rich body content (overrides the `message` attribute)
 * @fires slicc-error-retry - {} dispatched on retry click (bubbles, composed)
 */

/** Pixel size of the lucide header icon. */
const HEADER_ICON_SIZE = 14;
/** Default header label. */
const DEFAULT_LABEL = 'Something went wrong';
/** Default retry button label. */
const DEFAULT_BUTTON_LABEL = 'Try again';

const STYLE = `
:host{
  /* Error cards sit in the assistant column (left-aligned). Tokens default to
     the light palette and flip in dark mode via the library's outer scopes
     (.dark / [data-theme="dark"] / body.dark) or per-element [theme="dark"]. */
  display:block;width:100%;
  font-family:var(--ui,"adobe-clean","Inter",system-ui,sans-serif);
  --err-bg:color-mix(in srgb,var(--red) 8%,#fff);
  --err-border:color-mix(in srgb,var(--red) 38%,var(--line));
  --err-head:var(--red);
  --err-btn-bg:var(--red);
  --err-btn-ink:#fff;
}
:host-context(.dark),:host-context([data-theme="dark"]),:host([theme="dark"]){
  --err-bg:color-mix(in srgb,var(--red) 18%,var(--canvas));
  --err-border:color-mix(in srgb,var(--red) 40%,var(--line));
  --err-head:color-mix(in srgb,var(--red) 60%,var(--ink));
}
:host([theme="light"]){
  --err-bg:color-mix(in srgb,var(--red) 8%,#fff);
  --err-border:color-mix(in srgb,var(--red) 38%,var(--line));
  --err-head:var(--red);
}
*{box-sizing:border-box;}

.err{
  margin:2px 0 16px;
  max-width:85%;
  border:1px solid var(--err-border);
  background:var(--err-bg);
  border-radius:12px;
  padding:10px 12px;
  box-shadow:rgba(10,10,10,.05) 0 4px 14px -6px;
}

.eh{
  display:flex;align-items:center;gap:7px;
  font-family:var(--ui);font-size:10.5px;color:var(--err-head);
  margin-bottom:4px;
  font-weight:600;letter-spacing:.02em;text-transform:uppercase;
}
.eh .ic{display:inline-flex;flex:0 0 auto;align-items:center;color:var(--err-head);}
.eh .ic svg{display:block;}

.eb{font-size:12.5px;color:var(--ink);line-height:1.4;}
.eb ::slotted(b),.eb b{font-weight:600;}

.foot{display:flex;justify-content:flex-end;margin-top:8px;}
.retry{
  appearance:none;border:none;cursor:pointer;
  font-family:var(--ui);font-size:11.5px;font-weight:600;
  padding:5px 11px;border-radius:8px;
  background:var(--err-btn-bg);color:var(--err-btn-ink);
  display:inline-flex;align-items:center;gap:5px;
  transition:filter .12s ease;
}
.retry:hover{filter:brightness(1.08);}
.retry:focus-visible{outline:2px solid color-mix(in srgb,var(--err-btn-bg) 60%,var(--ink));outline-offset:2px;}
.retry svg{display:block;}
`;
const SHEET = sheet(STYLE);

export class SliccErrorCard extends HTMLElement {
  static readonly observedAttributes = ['label', 'message', 'button-label', 'theme'];

  readonly #root: ShadowRoot;
  #onRetryClick: ((e: MouseEvent) => void) | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  disconnectedCallback(): void {
    this.#unbindRetry();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** Header label (default "Something went wrong"). */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Error body text (escaped). Ignored when default-slot content is present. */
  get message(): string | null {
    return this.getAttribute('message');
  }

  set message(value: string | null) {
    if (value == null) this.removeAttribute('message');
    else this.setAttribute('message', value);
  }

  /** Retry button label (default "Try again"). */
  get buttonLabel(): string | null {
    return this.getAttribute('button-label');
  }

  set buttonLabel(value: string | null) {
    if (value == null) this.removeAttribute('button-label');
    else this.setAttribute('button-label', value);
  }

  /** Per-element theme override for the card tokens. */
  get theme(): 'light' | 'dark' | null {
    const t = this.getAttribute('theme');
    return t === 'light' || t === 'dark' ? t : null;
  }

  set theme(value: 'light' | 'dark' | null) {
    if (value == null) this.removeAttribute('theme');
    else this.setAttribute('theme', value);
  }

  /** Dispatch `slicc-error-retry` — used by the button and exposed for hosts. */
  retry(): void {
    this.dispatchEvent(
      new CustomEvent('slicc-error-retry', {
        detail: {},
        bubbles: true,
        composed: true,
      })
    );
  }

  #render(): void {
    const label = this.label ?? DEFAULT_LABEL;
    const message = this.message;
    const buttonLabel = this.buttonLabel ?? DEFAULT_BUTTON_LABEL;

    const icon = h('span', { class: 'ic', part: 'icon', 'aria-hidden': true });
    icon.append(iconEl('triangle-alert', { size: HEADER_ICON_SIZE }));

    const headerRow = h(
      'div',
      { class: 'eh', part: 'header' },
      icon,
      h('span', { class: 'lbl', part: 'label' }, label)
    );

    // Body: rich slotted content wins; otherwise the escaped `message`
    // attribute (a text node escapes by construction — no markup interpolation).
    const bodyRow = h('div', { class: 'eb', part: 'body' }, message != null ? message : h('slot'));

    const retryBtn = h(
      'button',
      {
        type: 'button',
        class: 'retry',
        part: 'button',
        'aria-label': buttonLabel,
      },
      iconEl('rotate-ccw', { size: 12 }),
      buttonLabel
    );

    const foot = h('div', { class: 'foot' }, retryBtn);

    const cardEl = h('div', { class: 'err', part: 'card' }, headerRow, bodyRow, foot);
    this.#root.replaceChildren(cardEl);

    this.#bindRetry();
  }

  #bindRetry(): void {
    this.#unbindRetry();
    const btn = this.#root.querySelector('.retry');
    if (!btn) return;
    this.#onRetryClick = () => this.retry();
    btn.addEventListener('click', this.#onRetryClick as EventListener);
  }

  #unbindRetry(): void {
    const btn = this.#root.querySelector('.retry');
    if (btn && this.#onRetryClick) {
      btn.removeEventListener('click', this.#onRetryClick as EventListener);
    }
    this.#onRetryClick = null;
  }
}

define('slicc-error-card', SliccErrorCard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-error-card': SliccErrorCard;
  }
}
