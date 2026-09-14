import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

export type ErrorAction = 'retry' | 'settings' | 'change-model' | 'login';

const HEADER_ICON_SIZE = 14;

const BUTTON_ICON_SIZE = 12;

const DEFAULT_LABEL = 'Something went wrong';

const DEFAULT_BUTTON_LABEL: Record<ErrorAction, string> = {
  retry: 'Try again',
  settings: 'Open Settings',
  'change-model': 'Change model',
  login: 'Log in again',
};

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
  min-width:0;
  overflow:hidden;
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

.eb{
  font-size:12.5px;color:var(--ink);line-height:1.4;
  /* API errors often arrive as one long JSON line. Break inside the card
     instead of dragging the chat column sideways (mirrors slicc-lick-card). */
  min-width:0;overflow-wrap:anywhere;word-break:break-word;
}
.eb ::slotted(b),.eb b{font-weight:600;}

.foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;}
.retry{
  appearance:none;border:none;cursor:pointer;
  font-family:var(--ui);font-size:11.5px;font-weight:600;
  padding:5px 11px;border-radius:8px;
  background:var(--err-btn-bg);color:var(--err-btn-ink);
  display:inline-flex;align-items:center;gap:5px;
  transition:filter .12s ease;
}
/* Secondary CTA: same geometry, outline weight — it must read as the
   quieter of two real choices, not as a disabled primary. */
.retry.ghost{
  background:transparent;color:var(--err-head);
  border:1px solid var(--err-border);
  padding:4px 10px;
}
.retry:hover{filter:brightness(1.08);}
.retry.ghost:hover{background:color-mix(in srgb,var(--err-btn-bg) 10%,transparent);filter:none;}
.retry.ghost:focus-visible{outline-color:var(--err-head);}
.retry:focus-visible{outline:2px solid color-mix(in srgb,var(--err-btn-bg) 60%,var(--ink));outline-offset:2px;}
.retry svg{display:block;}
`;
const SHEET = sheet(STYLE);

export class SliccErrorCard extends HTMLElement {
  static readonly observedAttributes = [
    'label',
    'message',
    'button-label',
    'secondary-button-label',
    'message-id',
    'action',
    'secondary-action',
    'no-action',
    'theme',
  ];

  readonly #root: ShadowRoot;
  #onActionClick: ((e: MouseEvent) => void) | null = null;
  #onSecondaryClick: ((e: MouseEvent) => void) | null = null;

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

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  get message(): string | null {
    return this.getAttribute('message');
  }

  set message(value: string | null) {
    if (value == null) this.removeAttribute('message');
    else this.setAttribute('message', value);
  }

  get buttonLabel(): string | null {
    return this.getAttribute('button-label');
  }

  set buttonLabel(value: string | null) {
    if (value == null) this.removeAttribute('button-label');
    else this.setAttribute('button-label', value);
  }

  get secondaryButtonLabel(): string | null {
    return this.getAttribute('secondary-button-label');
  }

  set secondaryButtonLabel(value: string | null) {
    if (value == null) this.removeAttribute('secondary-button-label');
    else this.setAttribute('secondary-button-label', value);
  }

  get messageId(): string | null {
    return this.getAttribute('message-id');
  }

  set messageId(value: string | null) {
    if (value == null) this.removeAttribute('message-id');
    else this.setAttribute('message-id', value);
  }

  get action(): ErrorAction {
    const a = this.getAttribute('action');
    if (a === 'settings' || a === 'change-model' || a === 'login') return a;
    return 'retry';
  }

  set action(value: ErrorAction | null) {
    if (value == null) this.removeAttribute('action');
    else this.setAttribute('action', value);
  }

  get secondaryAction(): ErrorAction | null {
    const a = this.getAttribute('secondary-action');
    if (a === 'settings' || a === 'change-model' || a === 'login' || a === 'retry') return a;
    return null;
  }

  set secondaryAction(value: ErrorAction | null) {
    if (value == null) this.removeAttribute('secondary-action');
    else this.setAttribute('secondary-action', value);
  }

  get noAction(): boolean {
    return this.hasAttribute('no-action');
  }

  set noAction(value: boolean) {
    this.toggleAttribute('no-action', value);
  }

  get theme(): 'light' | 'dark' | null {
    const t = this.getAttribute('theme');
    return t === 'light' || t === 'dark' ? t : null;
  }

  set theme(value: 'light' | 'dark' | null) {
    if (value == null) this.removeAttribute('theme');
    else this.setAttribute('theme', value);
  }

  retry(): void {
    this.dispatchEvent(
      new CustomEvent('slicc-error-retry', {
        detail: { messageId: this.getAttribute('message-id') ?? null },
        bubbles: true,
        composed: true,
      })
    );
  }

  openSettings(): void {
    this.dispatchEvent(
      new CustomEvent('slicc-error-open-settings', {
        detail: { messageId: this.getAttribute('message-id') ?? null },
        bubbles: true,
        composed: true,
      })
    );
  }

  changeModel(): void {
    this.dispatchEvent(
      new CustomEvent('slicc-error-change-model', {
        detail: { messageId: this.getAttribute('message-id') ?? null },
        bubbles: true,
        composed: true,
      })
    );
  }

  login(): void {
    this.dispatchEvent(
      new CustomEvent('slicc-error-login', {
        detail: { messageId: this.getAttribute('message-id') ?? null },
        bubbles: true,
        composed: true,
      })
    );
  }

  #emit(action: ErrorAction): void {
    if (action === 'settings') this.openSettings();
    else if (action === 'change-model') this.changeModel();
    else if (action === 'login') this.login();
    else this.retry();
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

    const bodyRow = h('div', { class: 'eb', part: 'body' }, message != null ? message : h('slot'));

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

    const secondary = this.secondaryAction;
    const secondaryLabel = secondary
      ? (this.secondaryButtonLabel ?? DEFAULT_BUTTON_LABEL[secondary])
      : null;
    const secondaryBtn =
      secondary && secondaryLabel != null
        ? h(
            'button',
            {
              type: 'button',
              class: 'retry ghost',
              part: 'secondary-button',
              'aria-label': secondaryLabel,
            },
            iconEl(BUTTON_ICON[secondary], { size: BUTTON_ICON_SIZE }),
            secondaryLabel
          )
        : null;

    const children = [headerRow, bodyRow];
    if (!this.noAction) {
      const foot = h('div', { class: 'foot' });
      if (secondaryBtn) foot.append(secondaryBtn);
      foot.append(actionBtn);
      children.push(foot);
    }

    const cardEl = h('div', { class: 'err', part: 'card' }, ...children);
    this.#root.replaceChildren(cardEl);

    this.#bindAction();
  }

  #bindAction(): void {
    this.#unbindAction();

    const btn = this.#root.querySelector('.retry:not(.ghost)');
    if (btn) {
      const action = this.action;
      this.#onActionClick = () => this.#emit(action);
      btn.addEventListener('click', this.#onActionClick as EventListener);
    }
    const ghost = this.#root.querySelector('.retry.ghost');
    const secondary = this.secondaryAction;
    if (ghost && secondary) {
      this.#onSecondaryClick = () => this.#emit(secondary);
      ghost.addEventListener('click', this.#onSecondaryClick as EventListener);
    }
  }

  #unbindAction(): void {
    const btn = this.#root.querySelector('.retry:not(.ghost)');
    if (btn && this.#onActionClick) {
      btn.removeEventListener('click', this.#onActionClick as EventListener);
    }
    this.#onActionClick = null;
    const ghost = this.#root.querySelector('.retry.ghost');
    if (ghost && this.#onSecondaryClick) {
      ghost.removeEventListener('click', this.#onSecondaryClick as EventListener);
    }
    this.#onSecondaryClick = null;
  }
}

define('slicc-error-card', SliccErrorCard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-error-card': SliccErrorCard;
  }
}
