import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SecretDialogSubmitDetail,
  SliccSecretDialog,
} from '../../src/overlay/slicc-secret-dialog.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(): SliccSecretDialog {
  const el = document.createElement('slicc-secret-dialog');
  document.body.appendChild(el);
  return el;
}

const part = <T extends HTMLElement>(el: SliccSecretDialog, name: string): T =>
  el.querySelector(`[part="${name}"]`) as T;

const nameInput = (el: SliccSecretDialog) => part<HTMLInputElement>(el, 'name');
const valueInput = (el: SliccSecretDialog) => part<HTMLInputElement>(el, 'value');
const domainInput = (el: SliccSecretDialog) => part<HTMLInputElement>(el, 'domain');
const domainInputs = (el: SliccSecretDialog) =>
  Array.from(el.querySelectorAll<HTMLInputElement>('[part="domain"]'));
const addBtns = (el: SliccSecretDialog) =>
  Array.from(el.querySelectorAll<HTMLButtonElement>('[part="domain-add"]'));
const removeBtns = (el: SliccSecretDialog) =>
  Array.from(el.querySelectorAll<HTMLButtonElement>('[part="domain-remove"]'));
const persistBox = (el: SliccSecretDialog) => part<HTMLInputElement>(el, 'persist');
const saveBtn = (el: SliccSecretDialog) => part<HTMLButtonElement>(el, 'save');
const cancelBtn = (el: SliccSecretDialog) => part<HTMLButtonElement>(el, 'cancel');
const revealBtn = (el: SliccSecretDialog) => part<HTMLButtonElement>(el, 'reveal');
const errorLine = (el: SliccSecretDialog) =>
  el.querySelector('.slicc-secret__error') as HTMLElement;
const innerDialog = (el: SliccSecretDialog) => el.querySelector('slicc-dialog') as HTMLElement;

/** Fill the form with a valid credential across two domain rows. */
function fill(el: SliccSecretDialog, value = 'ghp_realtoken'): void {
  nameInput(el).value = 'GITHUB_TOKEN';
  valueInput(el).value = value;
  domainInput(el).value = 'api.github.com';
  addBtns(el)[0].click();
  domainInputs(el)[1].value = '*.github.com';
}

const flush = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Every hint currently on screen, joined — the non-blocking guidance. */
const visibleHints = (el: SliccSecretDialog): string =>
  Array.from(el.querySelectorAll('.slicc-secret__hint'))
    .filter((hint) => !hint.hasAttribute('hidden'))
    .map((hint) => hint.textContent ?? '')
    .join(' ');

describe('slicc-secret-dialog', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-secret-dialog')).toBe(SliccSecretDialog);
  });

  it('exposes the documented ::part hooks', () => {
    const el = mount();
    for (const name of [
      'name',
      'value',
      'reveal',
      'domain',
      'domain-add',
      'domain-remove',
      'persist',
      'save',
      'cancel',
    ]) {
      expect(part(el, name), name).not.toBeNull();
    }
  });

  it('masks the value by default and toggles to plain text on reveal', () => {
    const el = mount();
    expect(valueInput(el).type).toBe('password');
    expect(revealBtn(el).getAttribute('aria-pressed')).toBe('false');

    revealBtn(el).click();
    expect(valueInput(el).type).toBe('text');
    expect(revealBtn(el).getAttribute('aria-pressed')).toBe('true');

    revealBtn(el).click();
    expect(valueInput(el).type).toBe('password');
  });

  it('defaults the scope to a single wildcard row and warns what it means', async () => {
    const el = mount();
    void el.open();
    await flush();
    expect(domainInputs(el).map((i) => i.value)).toEqual(['*']);
    expect(visibleHints(el)).toContain('any domain');
  });

  it('names the provider that cannot read the value', () => {
    const el = mount();
    el.provider = 'Anthropic';
    expect(innerDialog(el).getAttribute('description')).toBe(
      'Secure secrets cannot be read by Anthropic, and work only on the domains you specify.'
    );
    // Unset falls back to wording that is still true, just less concrete.
    el.provider = null;
    expect(innerDialog(el).getAttribute('description')).toContain('cannot be read by the model');
  });

  it('adds and removes domain rows, keeping one that cannot be removed', () => {
    const el = mount();
    void el.open();
    expect(domainInputs(el)).toHaveLength(1);
    // The last row's − is disabled: a secret with no scope cannot be stored.
    expect(removeBtns(el)[0].disabled).toBe(true);

    addBtns(el)[0].click();
    expect(domainInputs(el)).toHaveLength(2);
    expect(removeBtns(el).every((b) => b.disabled)).toBe(false);

    domainInputs(el)[0].value = 'api.github.com';
    domainInputs(el)[1].value = 'uploads.github.com';
    removeBtns(el)[1].click();
    expect(domainInputs(el).map((i) => i.value)).toEqual(['api.github.com']);
    expect(removeBtns(el)[0].disabled).toBe(true);
  });

  it('adds the new row directly below the one that was clicked', () => {
    const el = mount();
    void el.open({ domains: ['a.example', 'b.example'] });
    addBtns(el)[0].click();
    domainInputs(el)[1].value = 'inserted.example';
    expect(domainInputs(el).map((i) => i.value)).toEqual([
      'a.example',
      'inserted.example',
      'b.example',
    ]);
  });

  it('collects every row into the submitted scope', async () => {
    const el = mount();
    const pending = el.open({ domains: ['api.github.com', 'uploads.github.com'] });
    nameInput(el).value = 'GITHUB_TOKEN';
    valueInput(el).value = 'ghp_x';
    saveBtn(el).click();
    await expect(pending).resolves.toMatchObject({
      domains: ['api.github.com', 'uploads.github.com'],
    });
  });

  it('resolves open() with the submitted detail and never reflects the value', async () => {
    const el = mount();
    const pending = el.open();
    fill(el);
    persistBox(el).checked = true;
    saveBtn(el).click();

    await expect(pending).resolves.toEqual({
      name: 'GITHUB_TOKEN',
      value: 'ghp_realtoken',
      domains: ['api.github.com', '*.github.com'],
      persist: true,
    } satisfies SecretDialogSubmitDetail);
    // The credential is not recoverable from the DOM after the dialog closes.
    expect(el.outerHTML).not.toContain('ghp_realtoken');
    expect(valueInput(el).value).toBe('');
  });

  it('emits a composed, bubbling slicc-secret-submit', async () => {
    const el = mount();
    const seen: SecretDialogSubmitDetail[] = [];
    // Listened for on `document`, not the element: that only passes if the event
    // is composed AND bubbling, which is the contract under test.
    document.addEventListener(
      'slicc-secret-submit',
      (e) => seen.push((e as CustomEvent<SecretDialogSubmitDetail>).detail),
      { once: true }
    );
    const pending = el.open();
    fill(el);
    saveBtn(el).click();
    await pending;

    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('GITHUB_TOKEN');
    expect(seen[0].persist).toBe(false);
  });

  it('resolves null and emits slicc-secret-cancel on Cancel', async () => {
    const el = mount();
    const cancelled = vi.fn();
    el.addEventListener('slicc-secret-cancel', cancelled);
    const pending = el.open();
    fill(el);
    cancelBtn(el).click();

    await expect(pending).resolves.toBeNull();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(valueInput(el).value).toBe('');
  });

  it('resolves null when the modal shell dismisses (Escape / ✕)', async () => {
    const el = mount();
    const pending = el.open();
    innerDialog(el).dispatchEvent(
      new CustomEvent('slicc-dialog-close', { detail: { reason: 'escape' }, bubbles: true })
    );
    await expect(pending).resolves.toBeNull();
  });

  it('is persistent — a stray backdrop click cannot discard a typed credential', () => {
    const el = mount();
    expect(innerDialog(el).hasAttribute('persistent')).toBe(true);
  });

  it('blocks submit on an empty name, empty value, or empty scope', async () => {
    const el = mount();
    void el.open();

    saveBtn(el).click();
    expect(errorLine(el).textContent).toContain('name');

    nameInput(el).value = 'TOKEN';
    saveBtn(el).click();
    expect(errorLine(el).textContent).toContain('value');

    valueInput(el).value = 'abc';
    domainInput(el).value = '  ';
    saveBtn(el).click();
    expect(errorLine(el).textContent).toContain('allowed domain');
    // Blanking the one row is the only way to reach that state — the − button
    // stays disabled precisely so a scope-less secret cannot be submitted.
    expect(removeBtns(el)[0].disabled).toBe(true);
  });

  // The input joins pasted line breaks itself, so the mangling is invisible
  // without this warning — a pasted PEM key would look stored and be truncated.
  it('warns when a pasted value spanned multiple lines', () => {
    const el = mount();
    void el.open();
    const data = new DataTransfer();
    data.setData('text', '-----BEGIN KEY-----\nabc\n-----END KEY-----');
    valueInput(el).dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true })
    );
    expect(errorLine(el).textContent).toContain('single-line');
  });

  it('warns that a non-POSIX name will not be available as $NAME', async () => {
    const el = mount();
    void el.open({ name: 's3.r2.secret_access_key', domains: ['*.r2.cloudflarestorage.com'] });
    await flush();
    const hint = el.querySelector('.slicc-secret__hint:not([hidden])') as HTMLElement;
    expect(hint.textContent).toContain('$s3.r2.secret_access_key');
  });

  it('prefills a request and opens the options drawer for a suggested scope', async () => {
    const el = mount();
    void el.open({
      name: 'STAGING_TOKEN',
      domains: ['api.staging.example.com'],
      requester: 'Cone',
      reason: 'the deploy script needs a bearer token',
    });
    await flush();

    expect(nameInput(el).value).toBe('STAGING_TOKEN');
    expect(domainInput(el).value).toBe('api.staging.example.com');
    expect((el.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    // The unpunctuated reason gets a full stop, so it does not run into the
    // secrecy promise that follows it.
    expect(innerDialog(el).getAttribute('description')).toBe(
      'Cone: the deploy script needs a bearer token. Secure secrets cannot be read by the model, ' +
        'and work only on the domains you specify.'
    );
  });

  it('keeps the dialog open with the value intact when the store step fails', async () => {
    const el = mount();
    el.submitHandler = () => 'Keychain did not respond within 10s';
    void el.open();
    fill(el);
    saveBtn(el).click();
    await flush();

    expect(errorLine(el).textContent).toContain('Keychain');
    expect(valueInput(el).value).toBe('ghp_realtoken');
    expect(innerDialog(el).hasAttribute('open')).toBe(true);
    expect(saveBtn(el).disabled).toBe(false);
  });

  it('closes once the store step succeeds', async () => {
    const el = mount();
    const handler = vi.fn().mockResolvedValue(null);
    el.submitHandler = handler;
    const pending = el.open();
    fill(el);
    saveBtn(el).click();

    await expect(pending).resolves.toMatchObject({ name: 'GITHUB_TOKEN' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(innerDialog(el).hasAttribute('open')).toBe(false);
  });

  it('submits on Enter in the value field', async () => {
    const el = mount();
    const pending = el.open();
    fill(el);
    valueInput(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(pending).resolves.toMatchObject({ name: 'GITHUB_TOKEN' });
  });

  it('rejects a name the secret stores cannot key on', () => {
    const el = mount();
    void el.open();
    nameInput(el).value = 'has spaces!';
    valueInput(el).value = 'abc';
    saveBtn(el).click();
    expect(errorLine(el).textContent).toContain('letters, digits');
  });

  it('updates both hints live as the human types', () => {
    const el = mount();
    void el.open();

    nameInput(el).value = 'oauth.adobe.token';
    nameInput(el).dispatchEvent(new Event('input'));
    expect(visibleHints(el)).toContain('$oauth.adobe.token');

    domainInput(el).value = 'api.adobe.io';
    domainInput(el).dispatchEvent(new Event('input'));
    expect(visibleHints(el)).not.toContain('any domain');
  });

  it('shows a throwing store handler as the error and stays open', async () => {
    const el = mount();
    el.submitHandler = () => {
      throw new Error('bridge closed');
    };
    void el.open();
    fill(el);
    saveBtn(el).click();
    await flush();

    expect(errorLine(el).textContent).toContain('bridge closed');
    expect(innerDialog(el).hasAttribute('open')).toBe(true);
  });

  it('applies prefill attributes live, before and after the first open', () => {
    const el = mount();
    el.setAttribute('secret-name', 'FROM_ATTR');
    el.setAttribute('domain', 'api.example.com');
    el.setAttribute('persist-default', '');
    el.heading = 'Give me a token';

    expect(nameInput(el).value).toBe('FROM_ATTR');
    expect(domainInput(el).value).toBe('api.example.com');
    expect(persistBox(el).checked).toBe(true);
    expect(innerDialog(el).getAttribute('heading')).toBe('Give me a token');

    // Removal falls back to the documented defaults, not to an empty dialog.
    el.removeAttribute('domain');
    el.persistDefault = false;
    el.heading = null;
    expect(domainInput(el).value).toBe('*');
    expect(persistBox(el).checked).toBe(false);
    expect(innerDialog(el).getAttribute('heading')).toBe('Share a secret securely');
  });

  it('lets a request override the heading', async () => {
    const el = mount();
    void el.open({ heading: 'Adobe needs a key' });
    await flush();
    expect(innerDialog(el).getAttribute('heading')).toBe('Adobe needs a key');
  });

  it('surfaces a host-side failure through setError', () => {
    const el = mount();
    void el.open();
    el.setError('Keychain is locked');
    expect(errorLine(el).textContent).toBe('Keychain is locked');
    expect(saveBtn(el).disabled).toBe(false);
  });

  it('starts every open() from a cleared, masked value field', async () => {
    const el = mount();
    const first = el.open();
    fill(el);
    cancelBtn(el).click();
    await first;

    void el.open({ name: 'OTHER' });
    expect(valueInput(el).value).toBe('');
    expect(valueInput(el).type).toBe('password');
  });
});
