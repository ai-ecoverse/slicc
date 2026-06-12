// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controlled state shared with the account-store mock (hoisted so the
// vi.mock factory can close over it).
const h = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  configs: {} as Record<string, Record<string, unknown>>,
}));

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test Provider',
    description: 'A provider for testing.',
    isOAuth: false,
    requiresApiKey: true,
    ...overrides,
  };
}

vi.mock('../../src/providers/account-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/account-store.js')>(
    '../../src/providers/account-store.js'
  );
  return {
    ...actual,
    getAccounts: vi.fn(() => h.accounts),
    getProviderConfig: vi.fn((id: string) => h.configs[id] ?? makeConfig({ name: id })),
    getAvailableProviders: vi.fn(() => Object.keys(h.configs)),
    providerOffersLlmModels: vi.fn(() => true),
    getBaseUrlForProvider: vi.fn(() => ''),
    addAccount: vi.fn(),
    removeAccount: vi.fn(async () => {}),
    logoutOAuthAccount: vi.fn(async () => {}),
    exportProviders: vi.fn(() => ({ providers: [] })),
  };
});

vi.mock('../../src/scoops/tray-follower-status.js', () => ({
  getFollowerTrayRuntimeStatus: () => ({ state: 'inactive' as const }),
}));

vi.mock('../../src/scoops/tray-runtime-config.js', () => ({
  hasStoredTrayJoinUrl: () => false,
  storeTrayJoinUrl: vi.fn(() => ({ joinUrl: 'https://www.sliccy.ai/join/x', workerBaseUrl: 'w' })),
}));

vi.mock('../../src/ui/telemetry.js', () => ({ trackSettingsOpen: vi.fn() }));

import { addAccount, getProviderConfig, removeAccount } from '../../src/providers/account-store.js';

const dialogEl = () => document.querySelector('.dialog') as HTMLElement;
const titleText = () => dialogEl().querySelector('.dialog__title')?.textContent;
const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...dialogEl().querySelectorAll('button')].find((b) => b.textContent === text);

async function openDialog(options?: Parameters<typeof showProviderSettings>[0]): Promise<void> {
  ({ showProviderSettings } = await import('../../src/ui/provider-settings.js'));
  void showProviderSettings(options);
}

let showProviderSettings: typeof import('../../src/ui/provider-settings.js')['showProviderSettings'];

describe('showProviderSettings — dialog views', () => {
  beforeEach(() => {
    h.accounts = [];
    h.configs = {};
    vi.clearAllMocks();
    document.body.replaceChildren();
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    vi.stubGlobal('requestAnimationFrame', () => 0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('opens the add-account form when no accounts exist', async () => {
    await openDialog();
    expect(titleText()).toBe('Add Account');
    expect(dialogEl().querySelector('select')).toBeTruthy();
  });

  it('opens the accounts list when accounts exist', async () => {
    h.configs.openai = makeConfig({ name: 'OpenAI' });
    h.accounts = [{ providerId: 'openai', apiKey: 'sk-secret-value' }];
    await openDialog();
    expect(titleText()).toBe('Accounts');
    const names = [...dialogEl().querySelectorAll('div')].map((d) => d.textContent);
    expect(names).toContain('OpenAI');
    expect(buttonByText('Add Account')).toBeTruthy();
    expect(buttonByText('Get Started')).toBeTruthy();
  });

  it('renders edit + remove controls for each account, and a log-out toggle for OAuth accounts', async () => {
    h.configs.openai = makeConfig({ name: 'OpenAI' });
    h.configs.anthropic = makeConfig({ name: 'Anthropic OAuth', isOAuth: true });
    h.accounts = [
      { providerId: 'openai', apiKey: 'sk-secret-value' },
      { providerId: 'anthropic', accessToken: 'tok', userName: 'me@example.com' },
    ];
    await openDialog();
    expect(dialogEl().querySelectorAll('button[aria-label="Edit account"]')).toHaveLength(2);
    expect(dialogEl().querySelectorAll('button[aria-label="Remove account"]')).toHaveLength(2);
    // Only the OAuth account gets a logout toggle.
    expect(dialogEl().querySelectorAll('button[aria-label="Log out"]')).toHaveLength(1);
  });

  it('calls removeAccount when the remove control is clicked', async () => {
    h.configs.openai = makeConfig({ name: 'OpenAI' });
    h.accounts = [{ providerId: 'openai', apiKey: 'sk-secret-value' }];
    await openDialog();
    const removeBtn = dialogEl().querySelector(
      'button[aria-label="Remove account"]'
    ) as HTMLButtonElement;
    removeBtn.click();
    expect(removeAccount).toHaveBeenCalledWith('openai');
  });

  it('navigates from the list to the add-account form', async () => {
    h.configs.openai = makeConfig({ name: 'OpenAI' });
    h.accounts = [{ providerId: 'openai', apiKey: 'sk-secret-value' }];
    await openDialog();
    buttonByText('Add Account')?.click();
    expect(titleText()).toBe('Add Account');
  });

  it('validates the API key and only saves a valid one', async () => {
    h.configs.openai = makeConfig({ name: 'OpenAI', requiresApiKey: true });
    await openDialog();
    const select = dialogEl().querySelector('select') as HTMLSelectElement;
    select.value = 'openai';
    select.dispatchEvent(new Event('change'));

    const save = buttonByText('Add') as HTMLButtonElement;
    save.click();
    expect(addAccount).not.toHaveBeenCalled();
    const errorShown = [...dialogEl().querySelectorAll('div')].some((d) =>
      d.textContent?.startsWith('API key is required')
    );
    expect(errorShown).toBe(true);

    const keyInput = dialogEl().querySelector('input[type="password"]') as HTMLInputElement;
    keyInput.value = 'sk-a-valid-key';
    save.click();
    expect(addAccount).toHaveBeenCalledWith(
      'openai',
      'sk-a-valid-key',
      undefined,
      undefined,
      undefined
    );
  });

  it('opens the tray-join form with preferTrayJoin', async () => {
    await openDialog({ preferTrayJoin: true });
    expect(titleText()).toBe('Connect to another browser');
    const input = dialogEl().querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.placeholder).toContain('sliccy.ai/join');
  });

  it('shows the auto-join confirmation with autoJoinUrl', async () => {
    await openDialog({ autoJoinUrl: 'https://www.sliccy.ai/join/abc' });
    expect(titleText()).toBe('Connect this browser?');
    expect(buttonByText('Connect')).toBeTruthy();
  });

  it('shows a plain Cancel (not Back/tray) in connect mode', async () => {
    h.configs.openai = makeConfig({ name: 'OpenAI' });
    h.accounts = [{ providerId: 'openai', apiKey: 'sk-secret-value' }];
    await openDialog({ startInAddAccount: true });
    expect(titleText()).toBe('Add Account');
    expect(buttonByText('Cancel')).toBeTruthy();
    expect(buttonByText('Back')).toBeUndefined();
  });

  it('locks the provider select when editing an existing account', async () => {
    h.configs.openai = makeConfig({ name: 'OpenAI' });
    h.accounts = [{ providerId: 'openai', apiKey: 'sk-secret-value' }];
    await openDialog();
    (dialogEl().querySelector('button[aria-label="Edit account"]') as HTMLButtonElement).click();
    expect(titleText()).toBe('Edit Account');
    const select = dialogEl().querySelector('select') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(getProviderConfig).toHaveBeenCalledWith('openai');
  });
});
