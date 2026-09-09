import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
// Composed by tag — owns its registration.
import './slicc-dialog.js';

/**
 * What was submitted, WITHOUT the credential. This is the shape that travels on
 * the composed `slicc-secret-submit` event, so it must stay value-free: the
 * event crosses into the page, where any panel or sprinkle can listen for it.
 */
export interface SecretDialogSubmitSummary {
  /** Secret name (the store key; `$NAME` in the shell when POSIX-shaped). */
  name: string;
  /** Host/domain glob patterns the value may be unmasked for. */
  domains: string[];
  /** true → write to the persisted store; false → session-only, in-memory. */
  persist: boolean;
}

/**
 * What the human typed, once every field validates — the summary plus the
 * credential. Reaches only the two private paths: {@link
 * SliccSecretDialog.submitHandler} and the promise `open()` returns. It is
 * deliberately NOT what the DOM event carries.
 */
export interface SecretDialogSubmitDetail extends SecretDialogSubmitSummary {
  /** The real credential. Never reflected to an attribute, never logged. */
  value: string;
}

/** Prefill + framing for one open() call. */
export interface SecretDialogRequest {
  /** Suggested secret name (the agent's proposal, or a remembered one). */
  name?: string;
  /**
   * Suggested domain allowlist. With none, the human types one — there is no
   * default scope, because a wildcard nobody chose is a wildcard nobody read.
   */
  domains?: string[];
  /** Why the value is being asked for — shown verbatim under the heading. */
  reason?: string;
  /** Who is asking (agent label, scoop name). System-derived, never prose. */
  requester?: string;
  /** Initial state of the "keep after this session" checkbox. */
  persist?: boolean;
  /** Override the dialog title. */
  heading?: string;
  /**
   * Who cannot read the value — the model provider, named in the description
   * because "the agent" is abstract and a provider name is not.
   */
  provider?: string;
}

/**
 * Host-supplied store step. Return `null` on success (the dialog closes) or a
 * message to display while the dialog STAYS OPEN so the human can retry
 * without retyping the credential.
 */
export type SecretDialogSubmitHandler = (
  detail: SecretDialogSubmitDetail
) => Promise<string | null> | string | null;

/** The wildcard scope — every domain. Deliberately called out in the UI. */
const ANY_DOMAIN = '*';

const DEFAULT_HEADING = 'Share a secret securely';
/** Stand-in when no provider is named — still true, just less concrete. */
const DEFAULT_PROVIDER = 'the model';

function describeSecrecy(provider: string): string {
  return `Secure secrets cannot be read by ${provider}, and work only on the domains you specify.`;
}

/** Names that survive as `$NAME` in the agent shell (POSIX env identifiers). */
const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Everything the secret stores accept as a key (dotted subsystem names included). */
const ALLOWED_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Scoped, document-level stylesheet. Light-DOM host (it composes
 * `<slicc-dialog>` by tag), so the chrome is injected once into the host
 * document and selected by the host tag. Token-driven (`--canvas` / `--ink` /
 * `--line` / `--ghost` / `--txt-2` / `--txt-3` / `--ctx` / `--ui`) so dark mode
 * flips through the inherited theme scope.
 */
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

/** Split a comma/space separated mask list into patterns. */
function parseDomains(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

/**
 * `<slicc-secret-dialog>` — the one surface for handing SLICC a credential.
 * Shared by the composer's "Share secret securely" action and the agent's
 * `request_secret` tool so a human sees the same chrome either way.
 *
 * The value field is a password input by default with an eye toggle to reveal
 * it; Additional options carries the domain mask (what the fetch proxy will
 * unmask the value for) and a "keep after this session ends" checkbox that
 * chooses between the in-memory session store and the persisted one.
 *
 * Light DOM (it composes `<slicc-dialog>` BY TAG) with a scoped stylesheet
 * injected once into the host document. The typed value lives only in the
 * input: it is never reflected to an attribute, never emitted except in the
 * submit detail, and the field is cleared whenever the dialog closes.
 *
 * Imperative API: `open(req)` prefills, shows the dialog, and resolves with the
 * submitted {@link SecretDialogSubmitDetail} — or `null` on cancel (Cancel / ✕
 * / Escape / backdrop). Hosts that need to store the value before the dialog
 * goes away set {@link submitHandler}: returning a message keeps the dialog
 * open with that error so the human can retry without retyping.
 *
 * @attr heading - dialog title (default "Share a secret securely")
 * @attr secret-name - prefill for the name field
 * @attr domain - prefill for the domain mask (default `*`); comma-separated
 * @attr provider - the model provider named as unable to read the value
 * @attr persist-default - boolean; start with "keep after this session" checked
 * @csspart name - the name input
 * @csspart value - the secret value input
 * @csspart reveal - the show/hide toggle
 * @csspart domain - a domain input (one per allowed domain)
 * @csspart domain-add - the button that adds another domain row
 * @csspart domain-remove - the button that drops a domain row
 * @csspart persist - the persist checkbox
 * @csspart save - the primary submit button
 * @csspart cancel - the cancel button
 * @fires slicc-secret-submit - composed + bubbling; `SecretDialogSubmitDetail`
 * @fires slicc-secret-cancel - composed + bubbling; the human dismissed it
 */
export class SliccSecretDialog extends HTMLElement {
  static readonly observedAttributes = [
    'heading',
    'secret-name',
    'domain',
    'provider',
    'persist-default',
  ];

  /**
   * Optional store step run on submit, before the dialog closes. Returning a
   * string keeps the dialog open and shows it as the error.
   */
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

  /** The provider named as unable to read the value. */
  get provider(): string {
    return this.getAttribute('provider') || DEFAULT_PROVIDER;
  }

  set provider(value: string | null) {
    if (value == null) this.removeAttribute('provider');
    else this.setAttribute('provider', value);
  }

  /** Dialog title (reflected from the `heading` attribute). */
  get heading(): string {
    return this.getAttribute('heading') ?? DEFAULT_HEADING;
  }

  set heading(value: string | null) {
    if (value == null) this.removeAttribute('heading');
    else this.setAttribute('heading', value);
  }

  /** Whether "keep after this session ends" starts checked. */
  get persistDefault(): boolean {
    return this.hasAttribute('persist-default');
  }

  set persistDefault(value: boolean) {
    this.toggleAttribute('persist-default', value);
  }

  /**
   * Prefill, show, and resolve with what the human submitted — `null` on any
   * dismissal. The value field always starts empty and masked, whatever the
   * previous call left behind.
   */
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
    // The scope is the whole security claim, so it is never collapsed out of
    // sight: the drawer opens whenever the human still has to supply or review
    // one, which — with no default scope — is every time.
    this.#options.open = true;
    this.#syncHints();
    this.#dialog.show?.();
    requestAnimationFrame(() => (this.#name.value ? this.#value : this.#name).focus());
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  /** Show `message` as the dialog's error line (host-side store failures). */
  setError(message: string): void {
    this.#build();
    this.#error.textContent = message;
    this.#setBusy(false);
  }

  #setBusy(busy: boolean): void {
    this.#busy = busy;
    this.#save.disabled = busy;
    this.#save.textContent = busy ? 'Storing…' : 'Store secret';
    // Cancel goes with it: the write is already in flight and cannot be recalled,
    // so a "cancelled" answer over a secret that then lands is a lie. `#finish`
    // enforces the same rule for Escape and ✕, which have no button to disable.
    this.#cancel.disabled = busy;
  }

  #setRevealed(revealed: boolean): void {
    this.#value.type = revealed ? 'text' : 'password';
    this.#reveal.setAttribute('aria-pressed', String(revealed));
    this.#reveal.setAttribute('aria-label', revealed ? 'Hide secret' : 'Show secret');
    this.#reveal.replaceChildren(iconEl(revealed ? 'eye-off' : 'eye', { size: 16 }));
  }

  /** Non-blocking guidance: shell visibility for the name, breadth for the scope. */
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

  /** Every pattern currently in the rows, comma lists inside a row included. */
  #domainValues(): string[] {
    return this.#domainInputs().flatMap((input) => parseDomains(input.value));
  }

  #domainInputs(): HTMLInputElement[] {
    return Array.from(this.#domainRows.querySelectorAll<HTMLInputElement>('[part="domain"]'));
  }

  /**
   * Rebuild the rows to match `domains`, always keeping one.
   *
   * With nothing suggested that row starts EMPTY rather than `*`: a scope is the
   * only thing standing between a credential and any host the agent names, so it
   * is typed deliberately, never inherited from a default. Submission is blocked
   * until it is filled in.
   */
  #setDomains(domains: string[]): void {
    const list = domains.length > 0 ? domains : [''];
    this.#domainRows.replaceChildren(...list.map((domain) => this.#domainRow(domain)));
    this.#syncDomainRows();
  }

  /** One domain, with the − / + pair that edits the list trailing it. */
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

  /** A lone row cannot be removed: the store rejects a secret with no scope. */
  #syncDomainRows(): void {
    const rows = Array.from(this.#domainRows.children);
    for (const row of rows) {
      const remove = row.querySelector<HTMLButtonElement>('[part="domain-remove"]');
      if (remove) remove.disabled = rows.length === 1;
    }
  }

  /** Validate the form; returns the detail or the first problem found. */
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
        // Stay open with the value intact so a transient store failure costs a
        // click, not a re-paste from the password manager.
        this.setError(problem);
        return;
      }
      this.#setBusy(false);
    }
    // Value-free BY CONSTRUCTION, not by convention: this event is composed and
    // bubbling, so it leaves the component and reaches anything in the page that
    // listens — including panel or sprinkle code the agent wrote. The credential
    // travels only on `submitHandler` and the `open()` promise, both of which the
    // host wires up in its own realm.
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
    // A dismissal DURING the write is refused rather than raced: the store call
    // cannot be recalled, so answering "cancelled" here could leave a stored
    // secret behind a cancelled outcome. The submit path resolves it either way —
    // with the store's error, or with the detail on success.
    if (this.#busy && !detail) return;
    const resolve = this.#resolve;
    this.#resolve = null;
    this.#dialog.hide?.();
    // The plaintext never outlives the dialog: clearing here covers cancel,
    // submit, and dismissal alike.
    this.#value.value = '';
    this.#setRevealed(false);
    this.#setBusy(false);
    if (!detail) {
      this.dispatchEvent(new CustomEvent('slicc-secret-cancel', { bubbles: true, composed: true }));
    }
    resolve?.(detail);
  }

  /** The "Additional options" drawer: domain rows + session/saved choice. */
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
    // Injected here rather than in `connectedCallback` so a host that calls
    // `open()` before appending the element still gets the chrome styled.
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
    // A single-line input silently JOINS pasted line breaks, so a PEM key would
    // look accepted and be stored mangled. The stores are line-oriented too and
    // reject a newline with a 400 (docs/secrets.md), so say so at the paste.
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
    // A half-typed credential must not be lost to a stray backdrop click.
    this.#dialog.setAttribute('persistent', '');
    this.#dialog.append(body, this.#cancel, this.#save);
    this.#dialog.addEventListener('slicc-dialog-close', () => {
      if (this.#resolve) this.#finish(null);
    });
    this.append(this.#dialog);
    this.#syncHints();
  }
}

/**
 * The description line. A request's reason leads (it is why the human is looking
 * at this at all), and the secrecy promise follows it either way — that promise
 * is the reason to type a credential here rather than nowhere.
 */
function describeRequest(req: SecretDialogRequest, provider: string): string {
  const secrecy = describeSecrecy(provider);
  if (!req.reason) return secrecy;
  const who = req.requester ? `${req.requester}: ` : '';
  // The reason is somebody else's sentence and may not be punctuated; without
  // this the two run together ("…example.com Secure secrets cannot…").
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
