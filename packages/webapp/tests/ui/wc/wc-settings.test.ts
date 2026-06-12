// @vitest-environment jsdom
/**
 * WC-native account settings dialog: account rows, the add-account flow,
 * and the changed-accounts resolution — over the real provider-settings
 * store (localStorage-backed), with the library dialog stubbed by the
 * shared DOM stubs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { accountDetail, maskKey, showWcSettings } from '../../../src/ui/wc/wc-settings.js';

const log = { error: vi.fn() };

function seedAccounts(accounts: unknown[]): void {
  localStorage.setItem('slicc_accounts', JSON.stringify(accounts));
}

/** The dialog mounts after showWcSettings' async imports — wait for it. */
async function openDialog(): Promise<HTMLElement> {
  await vi.waitFor(() => {
    expect(document.querySelector('slicc-dialog')).toBeTruthy();
  });
  return document.querySelector('slicc-dialog') as HTMLElement;
}

/** Click the Done button and let the close event resolve the promise. */
function clickDone(dialog: HTMLElement): void {
  const done = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Done');
  expect(done).toBeTruthy();
  done?.click();
  // The stubbed dialog may not implement hide(); fire the close event the
  // real component dispatches.
  dialog.dispatchEvent(new CustomEvent('slicc-dialog-close', { bubbles: true }));
}

afterEach(() => {
  localStorage.removeItem('slicc_accounts');
  document.body.replaceChildren();
});

describe('maskKey', () => {
  it('shows only the edges of long keys and blanks short ones', () => {
    expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-a…mnop');
    expect(maskKey('short')).toBe('••••');
    expect(maskKey('')).toBe('');
  });
});

describe('accountDetail', () => {
  it('prefers the logged-out note, then user name, then login state, then masked key', () => {
    expect(
      accountDetail({ providerId: 'p', apiKey: '', loggedOut: true, userName: 'Lars' } as never)
    ).toBe('Logged out — was Lars');
    expect(accountDetail({ providerId: 'p', apiKey: '', userName: 'Lars' } as never)).toBe('Lars');
    expect(accountDetail({ providerId: 'p', apiKey: '', accessToken: 't' } as never)).toBe(
      'Logged in'
    );
    expect(accountDetail({ providerId: 'p', apiKey: 'sk-abcdefghijklmnop' } as never)).toBe(
      'sk-a…mnop'
    );
    expect(
      accountDetail({ providerId: 'p', apiKey: '', userName: 'L', baseUrl: 'https://x' } as never)
    ).toBe('L • https://x');
  });
});

describe('showWcSettings', () => {
  it('lists connected accounts and resolves false when nothing changed', async () => {
    seedAccounts([{ providerId: 'mystery-llm', apiKey: 'sk-abcdefghijklmnop' }]);
    const result = showWcSettings(log);
    const dialog = await openDialog();

    // The unknown provider id gets the synthesized fallback name.
    expect(dialog.textContent).toContain('Mystery Llm');
    expect(dialog.textContent).toContain('sk-a…mnop');

    clickDone(dialog);
    await expect(result).resolves.toBe(false);
    expect(document.querySelector('slicc-dialog')).toBeNull();
  });

  it('sizes through the dialog card, not a body min-width (border-clip regression)', async () => {
    const result = showWcSettings(log);
    const dialog = await openDialog();
    // The card width is driven via ::part(dialog) on the tagged dialog…
    expect(dialog.classList.contains('wcset-dialog')).toBe(true);
    const css = document.getElementById('slicc-wc-settings-style')?.textContent ?? '';
    expect(css).toContain('slicc-dialog.wcset-dialog::part(dialog){width:min(520px,92vw);}');
    // …and the body rule must NOT force a min-width that overflows the
    // card's content box (which clipped the account rows' right border).
    const bodyRule = css.match(/\.wcset\{[^}]*\}/)?.[0] ?? '';
    expect(bodyRule).not.toContain('min-width');
    clickDone(dialog);
    await result;
  });

  it('shows the empty state without accounts', async () => {
    const result = showWcSettings(log);
    const dialog = await openDialog();
    expect(dialog.textContent).toContain('No accounts configured.');
    clickDone(dialog);
    await result;
  });

  it('removes an account and resolves true', async () => {
    seedAccounts([{ providerId: 'mystery-llm', apiKey: 'sk-abcdefghijklmnop' }]);
    const result = showWcSettings(log);
    const dialog = await openDialog();

    const remove = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
    expect(remove).toBeTruthy();
    remove?.click();
    await vi.waitFor(() => {
      expect(dialog.textContent).toContain('No accounts configured.');
    });

    clickDone(dialog);
    await expect(result).resolves.toBe(true);
  });

  it('adds an API-key account through the picker flow', async () => {
    const result = showWcSettings(log);
    const dialog = await openDialog();

    const select = dialog.querySelector('select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    // The picker carries whatever the provider registry offers under test;
    // drive the flow with a synthetic option to stay registry-independent.
    const option = document.createElement('option');
    option.value = 'test-provider';
    option.textContent = 'Test Provider';
    select.append(option);
    select.value = 'test-provider';
    select.dispatchEvent(new Event('change'));

    const keyInput = dialog.querySelector('[data-testid="wcset-api-key"]') as HTMLInputElement;
    expect(keyInput).toBeTruthy();

    // Empty key is rejected with a status message.
    const save = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    save?.click();
    expect(dialog.textContent).toContain('An API key is required.');

    keyInput.value = 'sk-new-key-123456';
    save?.click();
    await vi.waitFor(() => {
      expect(dialog.textContent).toContain('Test Provider connected.');
    });
    expect(
      JSON.parse(localStorage.getItem('slicc_accounts') ?? '[]').some(
        (a: { providerId: string }) => a.providerId === 'test-provider'
      )
    ).toBe(true);

    clickDone(dialog);
    await expect(result).resolves.toBe(true);
  });

  it('announces slicc:accounts-changed live when an account is added, once per change', async () => {
    const changes: Event[] = [];
    const onChange = (e: Event): void => {
      changes.push(e);
    };
    window.addEventListener('slicc:accounts-changed', onChange);
    try {
      const result = showWcSettings(log);
      const dialog = await openDialog();
      // Opening with no edits must not announce (no needless catalog refetch).
      expect(changes).toHaveLength(0);

      const select = dialog.querySelector('select') as HTMLSelectElement;
      const option = document.createElement('option');
      option.value = 'test-provider';
      option.textContent = 'Test Provider';
      select.append(option);
      select.value = 'test-provider';
      select.dispatchEvent(new Event('change'));
      const keyInput = dialog.querySelector('[data-testid="wcset-api-key"]') as HTMLInputElement;
      keyInput.value = 'sk-new-key-123456';
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.click();

      await vi.waitFor(() => expect(changes).toHaveLength(1));
      clickDone(dialog);
      await result;
      // The dialog close re-renders nothing new, so no extra announcement.
      expect(changes).toHaveLength(1);
    } finally {
      window.removeEventListener('slicc:accounts-changed', onChange);
    }
  });
});
