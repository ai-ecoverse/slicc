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

import {
  FEATURE_FLAG_STORAGE_KEY,
  initFeatureFlags,
  isFeatureEnabled,
  setFeatureFlagOverride,
} from '../../../src/core/feature-flags.js';
import {
  accountDetail,
  maskKey,
  showExperimentalSettings,
  showThemeSettings,
  showWcSettings,
} from '../../../src/ui/wc/wc-settings.js';

// De-flake (release run 29453098737 failed here): under the full-monorepo
// `npm run test` (11k+ tests in parallel), showWcSettings' async dynamic
// imports + the <slicc-dialog> custom-element mount occasionally exceed
// vi.waitFor's default 1s window, timing out `openDialog` ("expected null to be
// truthy" / 5s test timeout). The dialog DOES mount — just slower under load —
// so give the DOM-appearance polls a generous budget and the file more test
// headroom. Scoped per-package CI (low concurrency) never hit this.
vi.setConfig({ testTimeout: 15000 });
const WAIT_FOR = { timeout: 5000, interval: 25 } as const;

/** Find the "Show timestamps" checkbox by its sibling label, if present. */
function findTimestampToggle(dialog: HTMLElement): HTMLInputElement | null {
  const label = [...dialog.querySelectorAll('label')].find(
    (l) => l.textContent === 'Show timestamps'
  );
  const row = label?.parentElement;
  return (row?.querySelector('input[type="checkbox"]') as HTMLInputElement | null) ?? null;
}

function findExperimentalToggle(dialog: HTMLElement): HTMLInputElement | null {
  return dialog.querySelector('#wcset-feature-experimental-settings');
}

function findPanelLayoutsToggle(dialog: HTMLElement): HTMLInputElement | null {
  return dialog.querySelector('#wcset-feature-panel-layouts');
}

function findAgenticMemoryToggle(dialog: HTMLElement): HTMLInputElement | null {
  return dialog.querySelector('#wcset-feature-agentic-memory');
}

const log = { error: vi.fn() };
/** Injected in place of `location.reload()` — jsdom cannot navigate. */
const reload = vi.fn();

function seedAccounts(accounts: unknown[]): void {
  localStorage.setItem('slicc_accounts', JSON.stringify(accounts));
}

/** The dialog mounts after showWcSettings' async imports — wait for it. */
async function openDialog(): Promise<HTMLElement> {
  await vi.waitFor(() => {
    expect(document.querySelector('slicc-dialog')).toBeTruthy();
  }, WAIT_FOR);
  return document.querySelector('slicc-dialog') as HTMLElement;
}

/** The footer button carrying `label`, whatever slot the dialog puts it in. */
function footerButton(dialog: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    ([...dialog.querySelectorAll('button')].find((b) => b.textContent === label) as
      | HTMLButtonElement
      | undefined) ?? null
  );
}

/**
 * The stubbed dialog may not implement hide(); fire the close event the real
 * component dispatches. This is also how an Esc / backdrop dismissal arrives.
 */
function closeDialog(dialog: HTMLElement): void {
  dialog.dispatchEvent(new CustomEvent('slicc-dialog-close', { bubbles: true }));
}

/** Click a footer button and let the close event resolve the promise. */
function clickFooter(dialog: HTMLElement, label: string): void {
  const btn = footerButton(dialog, label);
  expect(btn, `footer button "${label}"`).toBeTruthy();
  btn?.click();
  closeDialog(dialog);
}

/** Click the Done button and let the close event resolve the promise. */
function clickDone(dialog: HTMLElement): void {
  clickFooter(dialog, 'Done');
}

/** The pending-reload notice, present only once a toggle is waiting on a boot. */
function reloadNotice(dialog: HTMLElement): HTMLElement | null {
  return dialog.querySelector('.wcset__notice');
}

afterEach(() => {
  localStorage.removeItem('slicc_accounts');
  localStorage.removeItem('slicc_show_timestamps');
  localStorage.removeItem(FEATURE_FLAG_STORAGE_KEY);
  initFeatureFlags('standalone');
  reload.mockClear();
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
  it('does not render experimental UI', async () => {
    initFeatureFlags('standalone');
    const result = showWcSettings(log);
    const dialog = await openDialog();

    expect(dialog.textContent).not.toContain('Experimental');
    expect(findExperimentalToggle(dialog)).toBeNull();

    clickDone(dialog);
    await result;
  });

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

  it('no longer shows the "Show timestamps" chat control', async () => {
    const result = showWcSettings(log);
    const dialog = await openDialog();
    expect(dialog.textContent).not.toContain('Show timestamps');
    expect(findTimestampToggle(dialog)).toBeNull();
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
    }, WAIT_FOR);

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
    }, WAIT_FOR);
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

      await vi.waitFor(() => expect(changes).toHaveLength(1), WAIT_FOR);
      clickDone(dialog);
      await result;
      // The dialog close re-renders nothing new, so no extra announcement.
      expect(changes).toHaveLength(1);
    } finally {
      window.removeEventListener('slicc:accounts-changed', onChange);
    }
  });
});

describe('showExperimentalSettings', () => {
  it('lists each user-toggleable flag, and never the worker-controlled gate', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();

    expect(dialog.getAttribute('heading')).toBe('Experimental');
    // `panel-layouts` is toggleable, so it gets a row — the dialog is driven by
    // `listFlags()`, with no per-flag UI code.
    expect(findPanelLayoutsToggle(dialog)).not.toBeNull();
    expect(dialog.textContent).toContain('Panel layouts');
    expect(findAgenticMemoryToggle(dialog)).not.toBeNull();
    expect(dialog.textContent).toContain('Agentic memory');
    expect(dialog.textContent).toContain(
      'Curate session memory with a background agent instead of a one-shot extraction call.'
    );
    // `experimental-settings` gates this dialog and is NOT toggleable, so it must
    // never offer a switch that would let a user lock themselves out of it.
    expect(findExperimentalToggle(dialog)).toBeNull();

    clickDone(dialog);
    await result;
  });

  it('persists a panel-layouts toggle, so panels survive the next boot', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();
    const toggle = findPanelLayoutsToggle(dialog) as HTMLInputElement;

    expect(toggle.checked).toBe(false); // ships off
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    // Staged, not written: nothing reaches storage before the reload.
    expect(isFeatureEnabled('panel-layouts')).toBe(false);

    clickFooter(dialog, 'Reload now');
    await result;
    expect(isFeatureEnabled('panel-layouts')).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shows the compact-on-idle flag without tunable fields', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();
    try {
      expect(dialog.querySelector('#wcset-feature-compact-on-idle')).not.toBeNull();
      expect(dialog.querySelector('#wcset-idle-compaction-minutes')).toBeNull();
      expect(dialog.querySelector('#wcset-idle-compaction-min-tokens')).toBeNull();
    } finally {
      clickDone(dialog);
      await result;
    }
  });

  it('persists an agentic-memory toggle', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();
    const toggle = findAgenticMemoryToggle(dialog) as HTMLInputElement;

    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(isFeatureEnabled('agentic-memory')).toBe(false); // staged only

    clickFooter(dialog, 'Reload now');
    await result;
    expect(isFeatureEnabled('agentic-memory')).toBe(true);
  });

  it('does not mount when called directly while the central flag is off', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'off' });

    await expect(showExperimentalSettings(log, { reload })).resolves.toBeUndefined();
    expect(document.querySelector('slicc-dialog')).toBeNull();
  });

  it('ignores a local attempt to turn on a worker-disabled dialog', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'off' });
    setFeatureFlagOverride('experimental-settings', 'on');

    expect(localStorage.getItem(FEATURE_FLAG_STORAGE_KEY)).toBeNull();
    await showExperimentalSettings(log, { reload });
    expect(document.querySelector('slicc-dialog')).toBeNull();
  });

  it('cannot be hidden locally and remains available after reopening', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    setFeatureFlagOverride('experimental-settings', 'off');

    const firstResult = showExperimentalSettings(log, { reload });
    const firstDialog = await openDialog();
    clickDone(firstDialog);
    await firstResult;

    const reopenedResult = showExperimentalSettings(log, { reload });
    const reopenedDialog = await openDialog();
    // The local `off` override was ignored, so the dialog still opens and renders.
    expect(reopenedDialog.getAttribute('heading')).toBe('Experimental');
    expect(findPanelLayoutsToggle(reopenedDialog)).not.toBeNull();
    clickDone(reopenedDialog);
    await reopenedResult;
  });

  it('leaves the footer on Done and never reloads when nothing was touched', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();

    expect(reloadNotice(dialog)?.hidden).toBe(true);
    expect(footerButton(dialog, 'Done')).not.toBeNull();
    expect(footerButton(dialog, 'Revert')?.hidden).toBe(true);

    clickDone(dialog);
    await result;
    expect(reload).not.toHaveBeenCalled();
  });

  it('turns the footer into a reload confirm the moment a flag changes', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();
    const toggle = findAgenticMemoryToggle(dialog) as HTMLInputElement;

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    expect(reloadNotice(dialog)?.hidden).toBe(false);
    expect(reloadNotice(dialog)?.textContent).toContain('Nothing is saved until you reload');
    expect(footerButton(dialog, 'Done')).toBeNull();
    expect(footerButton(dialog, 'Reload now')).not.toBeNull();
    expect(footerButton(dialog, 'Revert')?.hidden).toBe(false);

    clickFooter(dialog, 'Reload now');
    await result;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('writes the override only as part of the reload, never before it', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const order: string[] = [];
    const recordingReload = vi.fn(() => {
      order.push(`reload:${localStorage.getItem(FEATURE_FLAG_STORAGE_KEY)}`);
    });
    const result = showExperimentalSettings(log, { reload: recordingReload });
    const dialog = await openDialog();
    const toggle = findAgenticMemoryToggle(dialog) as HTMLInputElement;

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    order.push(`toggled:${localStorage.getItem(FEATURE_FLAG_STORAGE_KEY)}`);

    clickFooter(dialog, 'Reload now');
    await result;

    // The write lands with the reload, not at toggle time — so no live consumer
    // (compaction, archive) can act on a value the user has not committed to.
    expect(order).toEqual(['toggled:null', 'reload:{"agentic-memory":"on"}']);
  });

  it('discards staged toggles on an Esc/backdrop dismissal', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();
    const toggle = findAgenticMemoryToggle(dialog) as HTMLInputElement;

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    closeDialog(dialog); // no footer click at all

    await result;
    // Nothing was ever written, so there is nothing half-applied to rescue.
    expect(reload).not.toHaveBeenCalled();
    expect(isFeatureEnabled('agentic-memory')).toBe(false);
    expect(localStorage.getItem(FEATURE_FLAG_STORAGE_KEY)).toBeNull();
  });

  it('drops the pending state when a flag is toggled back to where it started', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();
    const toggle = findAgenticMemoryToggle(dialog) as HTMLInputElement;

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(footerButton(dialog, 'Reload now')).not.toBeNull();

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));

    expect(reloadNotice(dialog)?.hidden).toBe(true);
    expect(footerButton(dialog, 'Done')).not.toBeNull();
    clickDone(dialog);
    await result;
    expect(reload).not.toHaveBeenCalled();
    // Toggling on then off must not pin an explicit `off` onto a flag that was
    // only riding its default — that would block a later central rollout.
    expect(localStorage.getItem(FEATURE_FLAG_STORAGE_KEY)).toBeNull();
  });

  it('restores the raw override for a touched flag that ends where it started', async () => {
    localStorage.setItem(FEATURE_FLAG_STORAGE_KEY, JSON.stringify({ 'panel-layouts': 'on' }));
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();
    const panel = findPanelLayoutsToggle(dialog) as HTMLInputElement;
    const agentic = findAgenticMemoryToggle(dialog) as HTMLInputElement;

    // panel-layouts goes off and back on; agentic-memory is a real change.
    panel.checked = false;
    panel.dispatchEvent(new Event('change'));
    panel.checked = true;
    panel.dispatchEvent(new Event('change'));
    agentic.checked = true;
    agentic.dispatchEvent(new Event('change'));

    clickFooter(dialog, 'Reload now');
    await result;

    // `panel-layouts` keeps the explicit `on` it opened with, not a rewrite.
    expect(JSON.parse(localStorage.getItem(FEATURE_FLAG_STORAGE_KEY) ?? '{}')).toEqual({
      'panel-layouts': 'on',
      'agentic-memory': 'on',
    });
  });

  it('reverts staged changes and closes without a reload or a write', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();
    const toggle = findAgenticMemoryToggle(dialog) as HTMLInputElement;

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    footerButton(dialog, 'Revert')?.click();

    expect(toggle.checked).toBe(false);
    expect(isFeatureEnabled('agentic-memory')).toBe(false);
    expect(reloadNotice(dialog)?.hidden).toBe(true);
    expect(footerButton(dialog, 'Done')).not.toBeNull();

    clickDone(dialog);
    await result;
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(FEATURE_FLAG_STORAGE_KEY)).toBeNull();
  });

  it('leaves an override the dialog did not touch alone', async () => {
    localStorage.setItem(FEATURE_FLAG_STORAGE_KEY, JSON.stringify({ 'panel-layouts': 'on' }));
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();
    const toggle = findAgenticMemoryToggle(dialog) as HTMLInputElement;

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    clickFooter(dialog, 'Reload now');
    await result;

    expect(isFeatureEnabled('panel-layouts')).toBe(true);
    expect(isFeatureEnabled('agentic-memory')).toBe(true);
  });

  it('ignores a stale persisted override after worker initialization', async () => {
    localStorage.setItem(
      FEATURE_FLAG_STORAGE_KEY,
      JSON.stringify({ 'experimental-settings': 'off' })
    );
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });

    const result = showExperimentalSettings(log, { reload });
    const dialog = await openDialog();
    expect(dialog.getAttribute('heading')).toBe('Experimental');
    clickDone(dialog);
    await result;
  });
});

describe('showThemeSettings', () => {
  it('shows the "Show timestamps" toggle initialized from the stored preference', async () => {
    localStorage.setItem('slicc_show_timestamps', 'false');
    const result = showThemeSettings(log);
    const dialog = await openDialog();

    expect(dialog.textContent).toContain('Show timestamps');
    const toggle = findTimestampToggle(dialog);
    expect(toggle).toBeTruthy();
    expect(toggle?.checked).toBe(false);

    clickDone(dialog);
    await result;
  });

  it('persists the timestamp preference when toggled', async () => {
    localStorage.setItem('slicc_show_timestamps', 'false');
    const result = showThemeSettings(log);
    const dialog = await openDialog();

    const toggle = findTimestampToggle(dialog);
    expect(toggle).toBeTruthy();
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event('change'));
    expect(localStorage.getItem('slicc_show_timestamps')).toBe('true');

    clickDone(dialog);
    await result;
  });
});
