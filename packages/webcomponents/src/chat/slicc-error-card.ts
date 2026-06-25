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
 * The `action` attribute switches the trailing affordance between four
 * CTAs that share the same surface:
 * - `"retry"` (default) — "Try again" label, `rotate-ccw` icon, fires
 *   `slicc-error-retry`.
 * - `"settings"` — "Open Settings" label, `settings` icon, fires
 *   `slicc-error-open-settings`. Used for failures the user fixes by
 *   opening Settings (e.g. "No API key configured") rather than by
 *   re-running the same failing turn.
 * - `"change-model"` — "Change model" label, `sparkles` icon, fires
 *   `slicc-error-change-model`. Used for invalid-model failures so the host
 *   can open the composer model picker instead of pointlessly re-running
 *   the same failed turn.
 * - `"login"` — "Log in again" label, `log-in` icon, fires
 *   `slicc-error-login`. Used for auth failures (e.g. an expired session or
 *   revoked token) so the host can re-run its login flow instead of
 *   re-running the same failed turn.
 *
 * @attr label - the header label (default "Something went wrong")
 * @attr message - error body text (escaped); ignored when slotted content is present
 * @attr button-label - action button label (defaults vary by `action`:
 *   "Try again" / "Open Settings" / "Change model" / "Log in again")
 * @attr message-id - id of the failed chat message this card stands for; echoed
 *   back on the action event so the host can bind it to THIS turn
 * @attr action - `retry` (default) | `settings` | `change-model` | `login`;
 *   switches the CTA event, default label, and glyph. Unknown values normalize
 *   back to `"retry"` so legacy hosts stay safe.
 * @attr theme - `light` | `dark`; per-element override of the inherited theme
 * @csspart card - the outer `.err` card
 * @csspart header - the `.eh` header row
 * @csspart icon - the `.ic` span wrapping the lucide `triangle-alert` `<svg>`
 * @csspart label - the header label span
 * @csspart body - the `.eb` body line
 * @csspart button - the action button
 * @slot - rich body content (overrides the `message` attribute)
 * @fires slicc-error-retry - { messageId: string | null } dispatched on retry
 *   click (bubbles, composed) when `action="retry"` (the default)
 * @fires slicc-error-open-settings - { messageId: string | null } dispatched on
 *   click (bubbles, composed) when `action="settings"`
 * @fires slicc-error-change-model - { messageId: string | null } dispatched on
 *   click (bubbles, composed) when `action="change-model"`
 * @fires slicc-error-login - { messageId: string | null } dispatched on
 *   click (bubbles, composed) when `action="login"`
 */

/** Recognized values for the `action` attribute. */
export type ErrorAction = 'retry' | 'settings' | 'change-model' | 'login';

/** Pixel size of the lucide header icon. */
const HEADER_ICON_SIZE = 14;
/** Pixel size of the lucide button icon. */
const BUTTON_ICON_SIZE = 12;
/** Default header label. */
const DEFAULT_LABEL = 'Something went wrong';
/** Default button label per action variant. */
const DEFAULT_BUTTON_LABEL: Record<ErrorAction, string> = {
  retry: 'Try again',
  settings: 'Open Settings',
  'change-model': 'Change model',
  login: 'Log in again',
};
/** Lucide icon name per action variant. */
const BUTTON_ICON: Record<ErrorAction, string> = {
  retry: 'rotate-ccw',
  settings: 'settings',
  'change-model': 'sparkles',
  login: 'log-in',
};

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
  static readonly observedAttributes = [
    'label',
    'message',
    'button-label',
    'message-id',
    'action',
    'theme',
  ];

  readonly #root: ShadowRoot;
  #onActionClick: ((e: MouseEvent) => void) | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  disconnectedCallback(): void {
    this.#unbindAction();
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

  /** Action button label (defaults vary by `action`). */
  get buttonLabel(): string | null {
    return this.getAttribute('button-label');
  }

  set buttonLabel(value: string | null) {
    if (value == null) this.removeAttribute('button-label');
    else this.setAttribute('button-label', value);
  }

  /**
   * Id of the failed chat message this card stands for. Echoed back on the
   * action event so the host can bind it to the SPECIFIC turn that produced
   * this card rather than the newest user message in the thread.
   */
  get messageId(): string | null {
    return this.getAttribute('message-id');
  }

  set messageId(value: string | null) {
    if (value == null) this.removeAttribute('message-id');
    else this.setAttribute('message-id', value);
  }

  /**
   * Action mode: `retry` (default) fires `slicc-error-retry`; `settings`
   * fires `slicc-error-open-settings`; `change-model` fires
   * `slicc-error-change-model`; `login` fires `slicc-error-login`. Any
   * unknown value is normalized back to `retry` so legacy hosts stay safe.
   */
  get action(): ErrorAction {
    const a = this.getAttribute('action');
    if (a === 'settings' || a === 'change-model' || a === 'login') return a;
    return 'retry';
  }

  set action(value: ErrorAction | null) {
    if (value == null) this.removeAttribute('action');
    else this.setAttribute('action', value);
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
        detail: { messageId: this.getAttribute('message-id') ?? null },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Dispatch `slicc-error-open-settings` — fired by the button in `settings` mode. */
  openSettings(): void {
    this.dispatchEvent(
      new CustomEvent('slicc-error-open-settings', {
        detail: { messageId: this.getAttribute('message-id') ?? null },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Dispatch `slicc-error-change-model` — fired by the button in `change-model` mode. */
  changeModel(): void {
    this.dispatchEvent(
      new CustomEvent('slicc-error-change-model', {
        detail: { messageId: this.getAttribute('message-id') ?? null },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Dispatch `slicc-error-login` — fired by the button in `login` mode. */
  login(): void {
    this.dispatchEvent(
      new CustomEvent('slicc-error-login', {
        detail: { messageId: this.getAttribute('message-id') ?? null },
        bubbles: true,
        composed: true,
      })
    );
  }

  #render(): void {
    const action = this.action;
    const label = this.label ?? DEFAULT_LABEL;
    const message = this.message;
    const buttonLabel = this.buttonLabel ?? DEFAULT_BUTTON_LABEL[action];
    const buttonIcon = BUTTON_ICON[action];

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

    // The class hook stays `retry` so existing CSS / shadow-piercing tests
    // keep matching across all three action variants.
    const actionBtn = h(
      'button',
      {
        type: 'button',
        class: 'retry',
        part: 'button',
        'aria-label': buttonLabel,
      },
      iconEl(buttonIcon, { size: BUTTON_ICON_SIZE }),
      buttonLabel
    );

    const foot = h('div', { class: 'foot' }, actionBtn);

    const cardEl = h('div', { class: 'err', part: 'card' }, headerRow, bodyRow, foot);
    this.#root.replaceChildren(cardEl);

    this.#bindAction();
  }

  #bindAction(): void {
    this.#unbindAction();
    const btn = this.#root.querySelector('.retry');
    if (!btn) return;
    const action = this.action;
    this.#onActionClick = () => {
      if (action === 'settings') this.openSettings();
      else if (action === 'change-model') this.changeModel();
      else if (action === 'login') this.login();
      else this.retry();
    };
    btn.addEventListener('click', this.#onActionClick as EventListener);
  }

  #unbindAction(): void {
    const btn = this.#root.querySelector('.retry');
    if (btn && this.#onActionClick) {
      btn.removeEventListener('click', this.#onActionClick as EventListener);
    }
    this.#onActionClick = null;
  }
}

define('slicc-error-card', SliccErrorCard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-error-card': SliccErrorCard;
  }
}
