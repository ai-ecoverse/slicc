import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { typingElement } from '../internal/typing-focus.js';

import './slicc-dialog.js';

export interface SecretDialogSubmitSummary {
  name: string;

  domains: string[];

  persist: boolean;
}

export interface SecretDialogSubmitDetail extends SecretDialogSubmitSummary {
  value: string;
}

export interface SecretDialogRequest {
  name?: string;

  domains?: string[];

  reason?: string;

  requester?: string;

  persist?: boolean;

  heading?: string;

  provider?: string;
}

export type SecretDialogSubmitHandler = (
  detail: SecretDialogSubmitDetail
) => Promise<string | null> | string | null;

const ANY_DOMAIN = '*';

const DEFAULT_HEADING = 'Share a secret securely';

const DEFAULT_PROVIDER = 'the model';

function describeSecrecy(provider: string): string {
  return `Secure secrets cannot be read by ${provider}, and work only on the domains you specify.`;
}

const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ALLOWED_NAME = /^[A-Za-z0-9_.-]+$/;

const STYLE = `
slicc-secret-dialog slicc-dialog::part(dialog) {
  width: min(480px, 92vw);
}
slicc-secret-dialog .slicc-secret__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: var(--ui);
}
slicc-secret-dialog .slicc-secret__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
slicc-secret-dialog .slicc-secret__label {
  font: 600 11px var(--ui);
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--txt-3);
}
slicc-secret-dialog .slicc-secret__input {
  font: 400 13px var(--ui);
  color: var(--ink);
  background: var(--canvas);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
slicc-secret-dialog .slicc-secret__input:focus {
  border-color: var(--ctx);
}
slicc-secret-dialog .slicc-secret__input--value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding-right: 38px;
}
slicc-secret-dialog .slicc-secret__value-wrap {
  position: relative;
}
slicc-secret-dialog .slicc-secret__reveal {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  border-radius: 7px;
  color: var(--txt-3);
  cursor: pointer;
}
slicc-secret-dialog .slicc-secret__reveal:hover {
  background: var(--ghost);
  color: var(--ink);
}
slicc-secret-dialog .slicc-secret__rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
slicc-secret-dialog .slicc-secret__row {
  display: flex;
  align-items: center;
  gap: 6px;
}
slicc-secret-dialog .slicc-secret__row .slicc-secret__input {
  flex: 1 1 auto;
}
slicc-secret-dialog .slicc-secret__row-btn {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--txt-3);
  cursor: pointer;
}
slicc-secret-dialog .slicc-secret__row-btn:hover:not([disabled]) {
  background: var(--ghost);
  color: var(--ink);
}
slicc-secret-dialog .slicc-secret__row-btn[disabled] {
  opacity: .4;
  cursor: default;
}
slicc-secret-dialog .slicc-secret__hint {
  font-size: 11.5px;
  color: var(--txt-3);
  line-height: 1.45;
}
slicc-secret-dialog .slicc-secret__hint[hidden] {
  display: none;
}
slicc-secret-dialog .slicc-secret__error {
  font-size: 12px;
  color: var(--danger, #d7373f);
  min-height: 15px;
  line-height: 1.35;
}
slicc-secret-dialog .slicc-secret__options {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0 10px;
}
slicc-secret-dialog .slicc-secret__options[open] {
  padding-bottom: 12px;
}
slicc-secret-dialog .slicc-secret__summary {
  font: 500 12.5px var(--ui);
  color: var(--txt-2);
  cursor: pointer;
  padding: 9px 0;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
slicc-secret-dialog .slicc-secret__summary::-webkit-details-marker {
  display: none;
}
slicc-secret-dialog .slicc-secret__opts-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
slicc-secret-dialog .slicc-secret__check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font: 400 12.5px var(--ui);
  color: var(--ink);
  cursor: pointer;
}
slicc-secret-dialog .slicc-secret__check input {
  margin: 1px 0 0;
  flex: 0 0 auto;
}
slicc-secret-dialog .slicc-secret__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 500 12px var(--ui);
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}
slicc-secret-dialog .slicc-secret__btn:hover {
  background: var(--ghost);
}
slicc-secret-dialog .slicc-secret__btn--save {
  background: var(--ink);
  color: var(--canvas);
  border-color: var(--ink);
}
slicc-secret-dialog .slicc-secret__btn--save:hover {
  background: color-mix(in srgb, var(--ink) 85%, var(--canvas));
}
slicc-secret-dialog .slicc-secret__btn[disabled] {
  opacity: .55;
  cursor: default;
}
`;

const STYLE_ID = 'slicc-secret-dialog-style';

function ensureSecretStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function parseDomains(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

export class SliccSecretDialog extends HTMLElement {
  static readonly observedAttributes = [
    'heading',
    'secret-name',
    'domain',
    'provider',
    'persist-default',
  ];

  submitHandler: SecretDialogSubmitHandler | null = null;

  #dialog!: HTMLElement & { show?: () => void; hide?: () => void };
  #name!: HTMLInputElement;
  #value!: HTMLInputElement;
  #reveal!: HTMLButtonElement;
  #domainRows!: HTMLElement;
  #persist!: HTMLInputElement;
  #save!: HTMLButtonElement;
  #cancel!: HTMLButtonElement;
  #options!: HTMLDetailsElement;
  #error!: HTMLElement;
  #nameHint!: HTMLElement;
  #domainHint!: HTMLElement;
  #built = false;
  #busy = false;
  #resolve: ((detail: SecretDialogSubmitDetail | null) => void) | null = null;

  connectedCallback(): void {
    this.#build();
  }

  attributeChangedCallback(name: string): void {
    if (!this.#built) return;
    if (name === 'heading') this.#dialog.setAttribute('heading', this.heading);
    else if (name === 'secret-name') this.#name.value = this.getAttribute('secret-name') ?? '';
    else if (name === 'domain') this.#setDomains(parseDomains(this.getAttribute('domain') ?? ''));
    else if (name === 'provider')
      this.#dialog.setAttribute('description', describeSecrecy(this.provider));
    else if (name === 'persist-default') this.#persist.checked = this.persistDefault;
  }

  get provider(): string {
    return this.getAttribute('provider') || DEFAULT_PROVIDER;
  }

  set provider(value: string | null) {
    if (value == null) this.removeAttribute('provider');
    else this.setAttribute('provider', value);
  }

  get heading(): string {
    return this.getAttribute('heading') ?? DEFAULT_HEADING;
  }

  set heading(value: string | null) {
    if (value == null) this.removeAttribute('heading');
    else this.setAttribute('heading', value);
  }

  get persistDefault(): boolean {
    return this.hasAttribute('persist-default');
  }

  set persistDefault(value: boolean) {
    this.toggleAttribute('persist-default', value);
  }

  open(req: SecretDialogRequest = {}): Promise<SecretDialogSubmitDetail | null> {
    this.#build();
    if (req.heading) this.heading = req.heading;
    if (req.provider) this.provider = req.provider;
    this.#dialog.setAttribute('heading', this.heading);
    this.#dialog.setAttribute('description', describeRequest(req, this.provider));
    this.#name.value = req.name ?? this.getAttribute('secret-name') ?? '';
    this.#setDomains(req.domains ?? parseDomains(this.getAttribute('domain') ?? ''));
    this.#persist.checked = req.persist ?? this.persistDefault;
    this.#value.value = '';
    this.#setRevealed(false);
    this.#error.textContent = '';
    this.#setBusy(false);

    this.#options.open = true;
    this.#syncHints();

    const userTyping = typingElement(this.ownerDocument) !== null;
    this.#dialog.show?.();
    if (!userTyping) {
      requestAnimationFrame(() => (this.#name.value ? this.#value : this.#name).focus());
    }
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  setError(message: string): void {
    this.#build();
    this.#error.textContent = message;
    this.#setBusy(false);
  }

  #setBusy(busy: boolean): void {
    this.#busy = busy;
    this.#save.disabled = busy;
    this.#save.textContent = busy ? 'Storing…' : 'Store secret';

    this.#cancel.disabled = busy;
  }

  #setRevealed(revealed: boolean): void {
    this.#value.type = revealed ? 'text' : 'password';
    this.#reveal.setAttribute('aria-pressed', String(revealed));
    this.#reveal.setAttribute('aria-label', revealed ? 'Hide secret' : 'Show secret');
    this.#reveal.replaceChildren(iconEl(revealed ? 'eye-off' : 'eye', { size: 16 }));
  }

  #syncHints(): void {
    const name = this.#name.value.trim();
    const posix = !name || POSIX_ENV_NAME.test(name);
    this.#nameHint.textContent = posix ? '' : `Not a shell name — no $${name} in the shell.`;
    this.#nameHint.toggleAttribute('hidden', posix);

    const wildcard = this.#domainValues().includes(ANY_DOMAIN);
    this.#domainHint.textContent = wildcard
      ? '* allows any domain. Narrow it to the API host.'
      : '';
    this.#domainHint.toggleAttribute('hidden', !wildcard);
  }

  #domainValues(): string[] {
    return this.#domainInputs().flatMap((input) => parseDomains(input.value));
  }

  #domainInputs(): HTMLInputElement[] {
    return Array.from(this.#domainRows.querySelectorAll<HTMLInputElement>('[part="domain"]'));
  }

  #setDomains(domains: string[]): void {
    const list = domains.length > 0 ? domains : [''];
    this.#domainRows.replaceChildren(...list.map((domain) => this.#domainRow(domain)));
    this.#syncDomainRows();
  }

  #domainRow(value: string): HTMLElement {
    const input = h('input', {
      type: 'text',
      class: 'slicc-secret__input',
      part: 'domain',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'api.github.com',
      'aria-label': 'Allowed domain',
    }) as HTMLInputElement;
    input.value = value;
    input.addEventListener('input', () => this.#syncHints());

    const row = h(
      'div',
      { class: 'slicc-secret__row' },
      input,
      this.#rowButton('minus', 'Remove this domain', 'domain-remove', () => {
        row.remove();
        this.#syncDomainRows();
        this.#syncHints();
      }),
      this.#rowButton('plus', 'Add another domain', 'domain-add', () => {
        const added = this.#domainRow('');
        row.after(added);
        this.#syncDomainRows();
        added.querySelector<HTMLInputElement>('[part="domain"]')?.focus();
      })
    );
    return row;
  }

  #rowButton(
    icon: 'plus' | 'minus',
    label: string,
    part: string,
    onClick: () => void
  ): HTMLButtonElement {
    const button = h(
      'button',
      { type: 'button', class: 'slicc-secret__row-btn', part, 'aria-label': label, title: label },
      iconEl(icon, { size: 14 })
    ) as HTMLButtonElement;
    button.addEventListener('click', onClick);
    return button;
  }

  #syncDomainRows(): void {
    const rows = Array.from(this.#domainRows.children);
    for (const row of rows) {
      const remove = row.querySelector<HTMLButtonElement>('[part="domain-remove"]');
      if (remove) remove.disabled = rows.length === 1;
    }
  }

  #collect(): SecretDialogSubmitDetail | string {
    const name = this.#name.value.trim();
    if (!name) return 'Give the secret a name.';
    if (!ALLOWED_NAME.test(name)) {
      return 'Use letters, digits, and . _ - in the name.';
    }
    const value = this.#value.value;
    if (!value) return 'Paste the secret value.';
    const domains = this.#domainValues();
    if (domains.length === 0) {
      return 'Every secret needs at least one allowed domain.';
    }
    return { name, value, domains, persist: this.#persist.checked };
  }

  async #submit(): Promise<void> {
    if (this.#busy) return;
    const collected = this.#collect();
    if (typeof collected === 'string') {
      this.#error.textContent = collected;
      return;
    }
    this.#error.textContent = '';
    if (this.submitHandler) {
      this.#setBusy(true);
      let problem: string | null;
      try {
        problem = await this.submitHandler(collected);
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
      }
      if (problem) {
        this.setError(problem);
        return;
      }
      this.#setBusy(false);
    }

    const { name, domains, persist } = collected;
    this.dispatchEvent(
      new CustomEvent<SecretDialogSubmitSummary>('slicc-secret-submit', {
        detail: { name, domains, persist },
        bubbles: true,
        composed: true,
      })
    );
    this.#finish(collected);
  }

  #finish(detail: SecretDialogSubmitDetail | null): void {
    if (this.#busy && !detail) return;
    const resolve = this.#resolve;
    this.#resolve = null;
    this.#dialog.hide?.();

    this.#value.value = '';
    this.#setRevealed(false);
    this.#setBusy(false);
    if (!detail) {
      this.dispatchEvent(new CustomEvent('slicc-secret-cancel', { bubbles: true, composed: true }));
    }
    resolve?.(detail);
  }

  #buildOptions(): void {
    this.#domainRows = h('div', { class: 'slicc-secret__rows' });
    this.#setDomains(parseDomains(this.getAttribute('domain') ?? ''));

    this.#persist = h('input', {
      type: 'checkbox',
      part: 'persist',
    }) as HTMLInputElement;
    this.#persist.checked = this.persistDefault;

    this.#options = h(
      'details',
      { class: 'slicc-secret__options' },
      h(
        'summary',
        { class: 'slicc-secret__summary' },
        iconEl('sliders-horizontal', { size: 14 }),
        'Additional options'
      ),
      h(
        'div',
        { class: 'slicc-secret__opts-body' },
        h(
          'div',
          { class: 'slicc-secret__field' },
          h('label', { class: 'slicc-secret__label' }, 'Domains'),
          this.#domainRows,
          h('div', { class: 'slicc-secret__hint' }, 'Globs allowed: *.github.com'),
          this.#domainHint
        ),
        h(
          'label',
          { class: 'slicc-secret__check' },
          this.#persist,
          h(
            'span',
            {},
            'Keep after this session ends',
            h('div', { class: 'slicc-secret__hint' }, 'Off: this session only.')
          )
        )
      )
    ) as HTMLDetailsElement;
  }

  #build(): void {
    if (this.#built) return;
    this.#built = true;

    ensureSecretStyle(this.ownerDocument);

    this.#name = h('input', {
      type: 'text',
      class: 'slicc-secret__input',
      part: 'name',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'GITHUB_TOKEN',
      'aria-label': 'Secret name',
    }) as HTMLInputElement;
    this.#name.value = this.getAttribute('secret-name') ?? '';
    this.#name.addEventListener('input', () => this.#syncHints());

    this.#value = h('input', {
      type: 'password',
      class: 'slicc-secret__input slicc-secret__input--value',
      part: 'value',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'Paste the value',
      'aria-label': 'Secret value',
    }) as HTMLInputElement;

    this.#value.addEventListener('paste', (e) => {
      const pasted = (e as ClipboardEvent).clipboardData?.getData('text') ?? '';
      if (/[\r\n]/.test(pasted.trim())) {
        this.#error.textContent =
          'That value spans multiple lines and was joined into one. Secrets must be single-line — base64-encode it first (base64 -w0 key.pem).';
      }
    });
    this.#value.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        void this.#submit();
      }
    });

    this.#reveal = h('button', {
      type: 'button',
      class: 'slicc-secret__reveal',
      part: 'reveal',
    }) as HTMLButtonElement;
    this.#reveal.addEventListener('click', () =>
      this.#setRevealed(this.#value.type === 'password')
    );

    this.#nameHint = h('div', { class: 'slicc-secret__hint', hidden: true });
    this.#domainHint = h('div', { class: 'slicc-secret__hint', hidden: true });
    this.#buildOptions();

    this.#error = h('div', {
      class: 'slicc-secret__error',
      role: 'alert',
      'aria-live': 'polite',
    });

    this.#cancel = h(
      'button',
      { type: 'button', class: 'slicc-secret__btn', part: 'cancel', slot: 'footer' },
      'Cancel'
    ) as HTMLButtonElement;
    this.#cancel.addEventListener('click', () => this.#finish(null));

    this.#save = h(
      'button',
      {
        type: 'button',
        class: 'slicc-secret__btn slicc-secret__btn--save',
        part: 'save',
        slot: 'footer',
      },
      'Store secret'
    ) as HTMLButtonElement;
    this.#save.addEventListener('click', () => void this.#submit());

    const body = h(
      'div',
      { class: 'slicc-secret__body' },
      h(
        'div',
        { class: 'slicc-secret__field' },
        h('label', { class: 'slicc-secret__label' }, 'Name'),
        this.#name,
        this.#nameHint
      ),
      h(
        'div',
        { class: 'slicc-secret__field' },
        h('label', { class: 'slicc-secret__label' }, 'Value'),
        h('div', { class: 'slicc-secret__value-wrap' }, this.#value, this.#reveal),
        h('div', { class: 'slicc-secret__hint' }, 'Single line. Stays in this tab.')
      ),
      this.#options,
      this.#error
    );

    this.#setRevealed(false);

    this.#dialog = this.ownerDocument.createElement('slicc-dialog') as HTMLElement & {
      show?: () => void;
      hide?: () => void;
    };
    this.#dialog.setAttribute('heading', this.heading);
    this.#dialog.setAttribute('description', describeSecrecy(this.provider));

    this.#dialog.setAttribute('persistent', '');
    this.#dialog.append(body, this.#cancel, this.#save);
    this.#dialog.addEventListener('slicc-dialog-close', () => {
      if (this.#resolve) this.#finish(null);
    });
    this.append(this.#dialog);
    this.#syncHints();
  }
}

function describeRequest(req: SecretDialogRequest, provider: string): string {
  const secrecy = describeSecrecy(provider);
  if (!req.reason) return secrecy;
  const who = req.requester ? `${req.requester}: ` : '';

  const reason = /[.!?]$/.test(req.reason.trim()) ? req.reason.trim() : `${req.reason.trim()}.`;
  return `${who}${reason} ${secrecy}`;
}

define('slicc-secret-dialog', SliccSecretDialog);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-secret-dialog': SliccSecretDialog;
  }
  interface HTMLElementEventMap {
    'slicc-secret-submit': CustomEvent<SecretDialogSubmitSummary>;
    'slicc-secret-cancel': CustomEvent<void>;
  }
}
