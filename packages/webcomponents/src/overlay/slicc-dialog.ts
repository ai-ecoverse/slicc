import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/** Why the dialog closed — forwarded on `slicc-dialog-close`. */
export type DialogCloseReason = 'backdrop' | 'escape' | 'close-button' | 'api';

const STYLE = `
:host { display: none; }
:host([open]) { display: block; }
.overlay {
  position: fixed; inset: 0; z-index: 100;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.55);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
  padding: 24px;
  opacity: 0; transition: opacity .16s ease;
}
:host([open]) .overlay { opacity: 1; }
.dialog {
  position: relative;
  width: 440px; max-width: 90vw; max-height: 86vh; overflow: auto;
  box-sizing: border-box;
  background: var(--canvas, #fff);
  border: 1px solid var(--line, #e1e1e1);
  border-radius: 16px;
  box-shadow: 0 18px 50px -12px rgba(10,10,10,.35), 0 4px 12px -4px rgba(10,10,10,.18);
  padding: 22px;
  font-family: var(--ui);
  transform: translateY(8px) scale(.98); transition: transform .18s cubic-bezier(.4,0,.2,1);
}
:host([open]) .dialog { transform: none; }
/* The card takes programmatic focus (tabindex -1) for modal focus management;
   suppress its focus ring — inner controls still show their own :focus-visible. */
.dialog:focus { outline: none; }
.title { font-size: 17px; font-weight: 700; color: var(--ink, #131313); padding-right: 28px; }
.desc { font-size: 13px; color: var(--txt-2, #505050); margin-top: 6px; line-height: 1.5; }
.body { margin-top: 16px; }
.body::slotted(*) { font-family: var(--ui); }
.footer { margin-top: 20px; display: flex; gap: 8px; justify-content: flex-end; }
.footer[hidden] { display: none; }
.x {
  position: absolute; top: 14px; right: 14px;
  width: 28px; height: 28px; display: grid; place-items: center;
  border: none; background: transparent; border-radius: 8px;
  color: var(--txt-3, #717171); cursor: pointer; transition: background .12s ease, color .12s ease;
}
.x:hover { background: var(--ghost, rgba(0,0,0,.05)); color: var(--ink, #131313); }
.x svg { display: block; }
@media (prefers-reduced-motion: reduce) {
  .overlay, .dialog { transition: none; }
}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-dialog>` — the modal dialog shell from the real webapp
 * (`.dialog-overlay` + `.dialog`), extracted as a standalone, content-agnostic
 * component: a blurred full-screen backdrop centering a card with an optional
 * heading + description, a default `<slot>` for the body (forms, lists — kept in
 * light DOM so the host styles them), and a `footer` slot for action buttons.
 *
 * It owns only the shell + dismissal: opening (`open` / `show()`), closing on the
 * backdrop, the Escape key, or the corner ✕ (each emits `slicc-dialog-close` with
 * a `reason`), and restoring focus. Themed via inherited tokens (`--canvas`,
 * `--ink`, `--txt-2/3`, `--line`, `--ghost`).
 *
 * @attr open - reflected; whether the modal is shown (drive via `show()`/`hide()`)
 * @attr heading - the dialog title (NOT `title`, which is the native tooltip attr)
 * @attr description - the muted sub-heading line
 * @attr persistent - boolean; a backdrop click does NOT close (Escape / ✕ still do)
 * @attr no-close-button - boolean; hides the corner ✕
 * @csspart overlay - the backdrop
 * @csspart dialog - the dialog card
 * @csspart title - the heading
 * @csspart close - the corner ✕ button
 * @slot - the dialog body (forms / content)
 * @slot footer - action buttons, right-aligned
 * @fires slicc-dialog-close - `{ reason }` when the dialog dismisses (composed, bubbling)
 */
export class SliccDialog extends HTMLElement {
  static readonly observedAttributes = ['open', 'heading', 'description', 'no-close-button'];

  readonly #root: ShadowRoot;
  #overlay!: HTMLElement;
  #dialog!: HTMLElement;
  #titleEl!: HTMLElement;
  #descEl!: HTMLElement;
  #closeBtn!: HTMLButtonElement;
  #lastFocus: HTMLElement | null = null;

  #onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.open) {
      e.stopPropagation();
      this.#close('escape');
    }
  };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];

    this.#titleEl = h('div', { class: 'title', part: 'title', id: 'slicc-dialog-title' });
    this.#descEl = h('div', { class: 'desc', part: 'description' });
    this.#closeBtn = h(
      'button',
      { class: 'x', part: 'close', type: 'button', 'aria-label': 'Close' },
      iconEl('x', { size: 18 })
    ) as HTMLButtonElement;
    const body = h('div', { class: 'body' }, h('slot'));
    const footer = h('div', { class: 'footer' }, h('slot', { name: 'footer' }));

    this.#dialog = h(
      'div',
      {
        class: 'dialog',
        part: 'dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'slicc-dialog-title',
        tabindex: '-1',
      },
      this.#closeBtn,
      this.#titleEl,
      this.#descEl,
      body,
      footer
    );
    this.#overlay = h('div', { class: 'overlay', part: 'overlay' }, this.#dialog);
    this.#root.replaceChildren(this.#overlay);

    this.#closeBtn.addEventListener('click', () => this.#close('close-button'));
    this.#overlay.addEventListener('mousedown', (e) => {
      // Only a press that both starts AND ends on the backdrop (not the card) closes.
      if (e.target === this.#overlay && !this.persistent) this.#close('backdrop');
    });
  }

  connectedCallback(): void {
    this.#sync();
  }

  disconnectedCallback(): void {
    document.removeEventListener('keydown', this.#onKey, true);
  }

  attributeChangedCallback(name: string): void {
    if (name === 'open') this.#sync();
    else this.#syncContent();
  }

  /** Whether the modal is shown. */
  get open(): boolean {
    return this.hasAttribute('open');
  }
  set open(value: boolean) {
    this.toggleAttribute('open', value);
  }

  /** The dialog heading. */
  get heading(): string | null {
    return this.getAttribute('heading');
  }
  set heading(value: string | null) {
    if (value == null) this.removeAttribute('heading');
    else this.setAttribute('heading', value);
  }

  /** The muted description line under the heading. */
  get description(): string | null {
    return this.getAttribute('description');
  }
  set description(value: string | null) {
    if (value == null) this.removeAttribute('description');
    else this.setAttribute('description', value);
  }

  /** Whether a backdrop click is ignored (Escape / ✕ still close). */
  get persistent(): boolean {
    return this.hasAttribute('persistent');
  }
  set persistent(value: boolean) {
    this.toggleAttribute('persistent', value);
  }

  show(): void {
    if (!this.open) this.open = true;
  }
  hide(): void {
    if (this.open) this.#close('api');
  }

  #close(reason: DialogCloseReason): void {
    this.open = false;
    this.dispatchEvent(
      new CustomEvent<{ reason: DialogCloseReason }>('slicc-dialog-close', {
        detail: { reason },
        bubbles: true,
        composed: true,
      })
    );
  }

  #syncContent(): void {
    this.#titleEl.textContent = this.heading ?? '';
    this.#titleEl.style.display = this.heading ? '' : 'none';
    this.#descEl.textContent = this.description ?? '';
    this.#descEl.style.display = this.description ? '' : 'none';
    this.#closeBtn.style.display = this.hasAttribute('no-close-button') ? 'none' : '';
  }

  #sync(): void {
    this.#syncContent();
    if (this.open) {
      this.#lastFocus = (this.getRootNode() as Document | ShadowRoot).activeElement as HTMLElement;
      document.addEventListener('keydown', this.#onKey, true);
      // Focus the card so Escape + tabbing land inside the modal.
      requestAnimationFrame(() => this.#dialog.focus());
    } else {
      document.removeEventListener('keydown', this.#onKey, true);
      this.#lastFocus?.focus?.();
      this.#lastFocus = null;
    }
  }
}

define('slicc-dialog', SliccDialog);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-dialog': SliccDialog;
  }
  interface HTMLElementEventMap {
    'slicc-dialog-close': CustomEvent<{ reason: DialogCloseReason }>;
  }
}
