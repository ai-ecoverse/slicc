// @vitest-environment jsdom
/**
 * Secrets page (`secrets.html` + `secrets-entry.ts`) driven through its own
 * UI: real DOM, real buttons, the real encrypted-storage adapter over an
 * in-memory `chrome.storage.local` and fake IndexedDB. Each flow checks the
 * success path (control) before the failure / guard path.
 */
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(__dirname, '../secrets.html'), 'utf8');

/** In-memory chrome.storage.local with the get(null | string | string[]) contract. */
function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const pick = (keys: null | string | string[] | undefined) => {
    if (keys == null) return { ...data };
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
  };
  return {
    data,
    get: vi.fn(async (keys?: null | string | string[]) => pick(keys)),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }),
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const setValue = (id: string, value: string) => {
  ($(id) as HTMLInputElement).value = value;
};
const toast = () => ({
  text: $('toast').textContent,
  error: $('toast').classList.contains('error'),
});
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('#list .secret-row')].map((r) => r.dataset['name']);

let store: ReturnType<typeof memoryStorage>;
const pageInits: EventListener[] = [];

async function openPage(initial: Record<string, unknown> = {}): Promise<void> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.head.replaceChildren(
    ...[...doc.head.childNodes].map((n) => document.importNode(n, true))
  );
  document.body.replaceChildren(
    ...[...doc.body.childNodes].map((n) => document.importNode(n, true))
  );
  store = memoryStorage(initial);
  (globalThis as any).chrome = { storage: { local: store }, runtime: { id: 'test-id' } };
  // Each import registers a DOMContentLoaded handler on the shared document:
  // drop the previous page instance's so only this one wires the fresh DOM.
  for (const fn of pageInits.splice(0)) document.removeEventListener('DOMContentLoaded', fn);
  const add = document.addEventListener.bind(document);
  const spy = vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    if (type === 'DOMContentLoaded') pageInits.push(fn as EventListener);
    add(type, fn, opts);
  });
  vi.resetModules();
  await import('../src/secrets-entry.js');
  spy.mockRestore();
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await flush();
}

/** jsdom's opaque-origin document has no localStorage; the page needs one. */
function memoryLocalStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, String(v));
    },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryLocalStorage(),
    configurable: true,
  });
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
  indexedDB.deleteDatabase('slicc-secrets');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('secrets page — list', () => {
  it('shows the empty state, then lists saved secrets sorted', async () => {
    await openPage();
    expect($('list').textContent).toContain('No secrets stored');
    await openPage({
      B_TOKEN: 'b',
      B_TOKEN_DOMAINS: 'b.com',
      A_TOKEN: 'a',
      A_TOKEN_DOMAINS: 'a.com',
    });
    expect(rows()).toEqual(['A_TOKEN', 'B_TOKEN']);
    // Migration ran: the plaintext values are now ciphertext at rest.
    expect(store.data['A_TOKEN']).toMatchObject({ ct: expect.any(String), iv: expect.any(String) });
  });

  it('reports a storage read failure in the list', async () => {
    await openPage();
    store.get.mockRejectedValue(new Error('storage gone'));
    $('refreshBtn').click();
    await flush();
    expect($('list').textContent).toContain('Failed to read storage');
  });

  it('copies a name to the clipboard, and reports a clipboard failure', async () => {
    await openPage({ A_TOKEN: 'a', A_TOKEN_DOMAINS: 'a.com' });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copy = () =>
      [...document.querySelectorAll<HTMLButtonElement>('#list button')].find(
        (b) => b.textContent === 'Copy name'
      );
    copy()?.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('A_TOKEN');
    expect(toast()).toEqual({ text: 'Copied "A_TOKEN"', error: false });
    writeText.mockRejectedValueOnce(new Error('denied'));
    copy()?.click();
    await flush();
    expect(toast()).toEqual({ text: 'Clipboard failed', error: true });
  });

  it('deletes only after confirmation, and reports a delete failure', async () => {
    await openPage({ A_TOKEN: 'a', A_TOKEN_DOMAINS: 'a.com' });
    const del = () =>
      [...document.querySelectorAll<HTMLButtonElement>('#list button')].find(
        (b) => b.textContent === 'Delete'
      );
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    del()?.click();
    await flush();
    expect(rows()).toEqual(['A_TOKEN']);
    confirmSpy.mockReturnValue(true);
    del()?.click();
    await flush();
    expect(rows()).toEqual([]);
    expect(store.data['A_TOKEN']).toBeUndefined();
    expect(toast().text).toBe('Deleted A_TOKEN');
    await openPage({ B_TOKEN: 'b', B_TOKEN_DOMAINS: 'b.com' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    store.remove.mockRejectedValueOnce(new Error('nope'));
    del()?.click();
    await flush();
    expect(toast()).toMatchObject({ error: true });
    expect(toast().text).toContain('Failed');
  });
});

describe('secrets page — forms', () => {
  it('saves a custom secret encrypted, and rejects one without domains', async () => {
    await openPage();
    $('c-save').click();
    await flush();
    expect(toast().error).toBe(true);
    setValue('c-name', 'MY_KEY');
    setValue('c-value', 'secret-value');
    setValue('c-domains', 'api.example.com, *.example.com');
    $('c-save').click();
    await flush();
    expect(toast()).toEqual({ text: 'Saved "MY_KEY"', error: false });
    expect(rows()).toContain('MY_KEY');
    expect(store.data['MY_KEY']).toMatchObject({ ct: expect.any(String) });
    expect(JSON.stringify(store.data)).not.toContain('secret-value');
    expect(store.data['MY_KEY_DOMAINS']).toBe('api.example.com,*.example.com');
    expect(($('c-name') as HTMLInputElement).value).toBe('');
    setValue('c-name', 'X');
    setValue('c-value', 'y');
    $('c-clear').click();
    expect(($('c-name') as HTMLInputElement).value).toBe('');
    expect(($('c-value') as HTMLInputElement).value).toBe('');
  });

  it('saves an S3 profile, rejects an incomplete one, and clears the form', async () => {
    await openPage();
    setValue('s3-profile', 'aws');
    $('s3-save').click();
    await flush();
    expect(toast().error).toBe(true);
    setValue('s3-key', 'AKIAEXAMPLE');
    setValue('s3-secret', 'secretKey/123');
    setValue('s3-region', 'eu-west-1');
    setValue('s3-endpoint', 'https://minio.example.com');
    ($('s3-pathstyle') as HTMLSelectElement).value = 'true';
    setValue('s3-domains', 'minio.example.com');
    $('s3-save').click();
    await flush();
    expect(toast()).toEqual({ text: 'Saved profile "aws"', error: false });
    expect(rows()).toEqual(
      expect.arrayContaining(['s3.aws.access_key_id', 's3.aws.secret_access_key'])
    );
    expect(JSON.stringify(store.data)).not.toContain('secretKey/123');
    expect(($('s3-profile') as HTMLInputElement).value).toBe('');
    setValue('s3-key', 'x');
    $('s3-clear').click();
    expect(($('s3-key') as HTMLInputElement).value).toBe('');
    expect(($('s3-pathstyle') as HTMLSelectElement).value).toBe('');
  });

  it('surfaces an unexpected save failure as a toast', async () => {
    await openPage();
    store.set.mockRejectedValue(new Error('quota'));
    setValue('c-name', 'MY_KEY');
    setValue('c-value', 'v');
    setValue('c-domains', 'a.com');
    $('c-save').click();
    await flush();
    expect(toast()).toMatchObject({ error: true });
    expect(toast().text).toContain('Failed');
  });

  it('switches panes from the tab strip', async () => {
    await openPage();
    document.querySelector<HTMLButtonElement>('.tab[data-pane="oauth-domains"]')?.click();
    expect($('pane-oauth-domains').classList.contains('active')).toBe(true);
    expect($('pane-s3').classList.contains('active')).toBe(false);
  });
});

describe('secrets page — OAuth extra domains', () => {
  it('validates input, adds, lists, rejects duplicates, removes and clears', async () => {
    await openPage();
    expect($('od-list').textContent).toContain('No extras configured');
    $('od-add').click();
    expect(toast()).toEqual({ text: 'Provider is required', error: true });
    setValue('od-provider', 'adobe');
    $('od-add').click();
    expect(toast()).toEqual({ text: 'Domain is required', error: true });
    setValue('od-domain', 'admin.da.live');
    $('od-add').click();
    expect(toast()).toEqual({ text: 'Added admin.da.live to adobe', error: false });
    expect($('od-list').textContent).toContain('admin.da.live');
    setValue('od-domain', 'admin.da.live');
    $('od-add').click();
    expect(toast()).toEqual({ text: 'Already in adobe extras', error: true });
    // A failed write (e.g. quota) is reported, not swallowed.
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota exceeded');
    });
    setValue('od-domain', 'other.da.live');
    $('od-add').click();
    expect(toast().error).toBe(true);
    expect(toast().text).toContain('quota');
    setItem.mockRestore();
    setValue('od-domain', '*.da.live');
    $('od-add').click();
    const remove = [...$('od-list').querySelectorAll('button')].find(
      (b) => b.textContent === 'Remove'
    );
    remove?.click();
    expect(toast().text).toMatch(/^Removed .* from adobe$/);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const clear = () =>
      [...$('od-list').querySelectorAll('button')].find((b) => b.textContent === 'Clear');
    clear()?.click();
    expect($('od-list').textContent).toContain('adobe');
    confirmSpy.mockReturnValue(true);
    clear()?.click();
    expect(toast().text).toBe('Cleared extras for adobe');
    expect($('od-list').textContent).toContain('No extras configured');
  });
});
