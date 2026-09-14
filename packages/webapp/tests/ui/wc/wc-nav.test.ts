// @vitest-environment jsdom

import { hasIcon } from '@slicc/webcomponents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const showWcSettingsSpy = vi.fn(async () => undefined);
const showExperimentalSettingsSpy = vi.fn(async () => undefined);
vi.mock('../../../src/ui/wc/wc-settings.js', () => ({
  showExperimentalSettings: showExperimentalSettingsSpy,
  showWcSettings: showWcSettingsSpy,
}));

vi.mock('../../../src/providers/oauth-service.js', () => ({
  createOAuthLauncher: () => async () => '',
  createInterceptingOAuthLauncherForCurrentRuntime: async () => null,
}));

const { copyTextToClipboardSpy, showSyncEnabledDialogSpy } = vi.hoisted(() => ({
  copyTextToClipboardSpy: vi.fn(async () => true),
  showSyncEnabledDialogSpy: vi.fn(),
}));
vi.mock('../../../src/ui/sync-dialog.js', () => ({
  showSyncEnabledDialog: showSyncEnabledDialogSpy,
}));
vi.mock('../../../src/ui/clipboard.js', () => ({
  copyTextToClipboard: copyTextToClipboardSpy,
}));
vi.mock('../../../src/ui/legacy-styles.js', () => ({
  loadLegacyDialogStyles: vi.fn(async () => undefined),
}));

import {
  FEATURE_FLAG_STORAGE_KEY,
  initFeatureFlags,
  setFeatureFlagOverride,
} from '../../../src/core/feature-flags.js';
import { registerProviderConfig, unregisterProviderConfig } from '../../../src/providers/index.js';
import { setLeaderTrayRuntimeStatus } from '../../../src/scoops/tray-leader.js';
import type { WorkUnitModel } from '../../../src/scoops/types.js';
import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import type { GroupedModels } from '../../../src/ui/provider-settings.js';
import { accountIdentity, modelListForMeta, wireWcNav } from '../../../src/ui/wc/wc-nav.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';
import type { WorkUnitClient, WorkUnitSummary } from '../../../src/work-unit/client/types.js';

afterEach(() => {
  localStorage.removeItem(FEATURE_FLAG_STORAGE_KEY);
  initFeatureFlags('standalone');
  document.body.replaceChildren();
});

describe('modelListForMeta', () => {
  it('flattens provider groups into picker rows with provider-qualified ids', () => {
    const groups = [
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        models: [{ id: 'claude-opus-4-8', name: 'Opus 4.8' }, { id: 'claude-haiku-4-5' }],
      },
      { providerId: 'openai', providerName: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
    ] as unknown as GroupedModels[];
    expect(modelListForMeta(groups)).toEqual([
      { name: 'Opus 4.8', provider: 'Anthropic', id: 'anthropic:claude-opus-4-8' },
      { name: 'claude-haiku-4-5', provider: 'Anthropic', id: 'anthropic:claude-haiku-4-5' },
      { name: 'GPT-5', provider: 'OpenAI', id: 'openai:gpt-5' },
    ]);
  });
});

describe('accountIdentity', () => {
  it('prefers an account with both avatar and name', () => {
    expect(
      accountIdentity([
        { providerId: 'adobe', userName: 'Lars' },
        { providerId: 'github', userName: 'Lars Trieloff', userAvatar: 'https://a/b.png' },
      ])
    ).toEqual({ name: 'Lars Trieloff', avatarUrl: 'https://a/b.png', provider: 'github' });
  });

  it('falls back to a name-only account, and null when anonymous', () => {
    expect(accountIdentity([{ providerId: 'adobe', userName: 'Lars' }])).toEqual({
      name: 'Lars',
      avatarUrl: undefined,
      provider: 'adobe',
    });
    expect(accountIdentity([{ providerId: 'x' }])).toBeNull();
    expect(accountIdentity([])).toBeNull();
  });
});

function makeClient(overrides: Record<string, unknown> = {}): OffscreenClient {
  const cone = {
    jid: 'cone_1',
    name: 'Cone',
    folder: 'cone',
    isCone: true,
    type: 'cone',
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: '2026-08-22T00:00:00.000Z',
  };
  return {
    updateModel: vi.fn(),
    setScoopModel: vi.fn().mockResolvedValue(true),
    getScoops: () => [cone],
    getScoop: (jid: string) => (jid === cone.jid ? cone : undefined),
    selectedScoopJid: cone.jid,
    ...overrides,
  } as unknown as OffscreenClient;
}

function coneSummaries(): WorkUnitSummary[] {
  return [
    {
      assistantLabel: 'sliccy',
      addedAt: '2026-08-22T00:00:00.000Z',
      fill: 0,
      folder: 'cone',
      id: 'cone_1',
      name: 'Cone',
      parentId: null,
      role: 'primary',
      state: 'idle',
    },
  ];
}

function workUnitsOver(client: OffscreenClient): Pick<WorkUnitClient, 'setModel'> {
  const kernel = client as unknown as {
    setScoopModel(jid: string, model: WorkUnitModel): Promise<boolean>;
  };
  return { setModel: (id, model) => kernel.setScoopModel(id, model) };
}

describe('wireWcNav', () => {
  function makeRefs(): WcShellRefs {
    const composerMeta = document.createElement('slicc-composer-meta');
    const avatarMenu = document.createElement('slicc-avatar-menu');
    avatarMenu.append(document.createElement('slicc-avatar'));
    const inputCard = document.createElement('slicc-input-card');
    inputCard.append(document.createElement('slicc-send-button'));
    const thread = document.createElement('slicc-chat-thread');
    const floatbar = document.createElement('slicc-floatbar');
    document.body.append(composerMeta, avatarMenu, inputCard, thread, floatbar);
    return { composerMeta, avatarMenu, inputCard, thread, floatbar } as unknown as WcShellRefs;
  }

  it('feeds the model picker, persists selection, and wires the menu', async () => {
    const refs = makeRefs();
    const client = makeClient();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });

    expect(Array.isArray((refs.composerMeta as HTMLElement & { models?: unknown }).models)).toBe(
      true
    );
    expect(refs.avatarMenu.items.some((i) => i.id === 'settings')).toBe(true);

    expect(refs.avatarMenu.items.some((i) => i.id === 'tray-enable')).toBe(true);

    refs.composerMeta.dispatchEvent(
      new CustomEvent('model-change', {
        bubbles: true,
        detail: { id: 'adobe:claude-opus-4-8' },
      })
    );

    expect(localStorage.getItem('selected-model')).toBe('adobe:claude-opus-4-8');

    expect(client.setScoopModel).toHaveBeenCalledWith('cone_1', {
      provider: 'adobe',
      id: 'claude-opus-4-8',
    });
    expect(client.updateModel).not.toHaveBeenCalled();
  });

  it('shows Experimental features immediately after Export transcript with a real icon', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const refs = makeRefs();
    const client = makeClient();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });

    const exportIndex = refs.avatarMenu.items.findIndex((item) => item.id === 'export-transcript');
    const experimental = refs.avatarMenu.items[exportIndex + 1];
    expect(experimental).toEqual({
      id: 'experimental-settings',
      label: 'Experimental features…',
      icon: 'flask-conical',
    });
    expect(hasIcon(experimental?.icon ?? '')).toBe(true);
  });

  it('removes Experimental features on the next menu open when the worker turns it off', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const refs = makeRefs();
    const client = makeClient();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });
    expect(refs.avatarMenu.items.some((item) => item.id === 'experimental-settings')).toBe(true);

    initFeatureFlags('standalone', { 'experimental-settings': 'off' });
    setFeatureFlagOverride('experimental-settings', 'on');
    refs.avatarMenu.dispatchEvent(
      new CustomEvent('slicc-avatar-menu-toggle', { detail: { open: true } })
    );

    expect(refs.avatarMenu.items.some((item) => item.id === 'experimental-settings')).toBe(false);
    expect(localStorage.getItem(FEATURE_FLAG_STORAGE_KEY)).toBeNull();
  });

  it('opens the standalone Experimental dialog from its avatar action', async () => {
    initFeatureFlags('standalone', { 'experimental-settings': 'on' });
    const refs = makeRefs();
    const client = makeClient();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });

    showExperimentalSettingsSpy.mockClear();
    refs.avatarMenu.dispatchEvent(
      new CustomEvent('slicc-avatar-action', { detail: { id: 'experimental-settings' } })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(showExperimentalSettingsSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the avatar identity when signed out (so the component shows ?)', async () => {
    const refs = makeRefs();

    const avatar = refs.avatarMenu.querySelector('slicc-avatar') as HTMLElement;
    avatar.setAttribute('name', 'SLICC');
    avatar.setAttribute('src', 'https://stale.example/old.png');
    const client = makeClient();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });

    expect(avatar.hasAttribute('name')).toBe(false);
    expect(avatar.hasAttribute('src')).toBe(false);
    expect(avatar.hasAttribute('initials')).toBe(false);
  });

  it('paints the account avatar onto the nav avatar AND the composer send button', async () => {
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([
        {
          providerId: 'github',
          apiKey: 'x',
          userName: 'Lars Trieloff',
          userAvatar: 'https://avatars.example/lars.png',
        },
      ])
    );
    try {
      const refs = makeRefs();
      const client = makeClient();
      await wireWcNav({
        refs,
        client,
        workUnits: workUnitsOver(client),
        getUnits: () => coneSummaries(),
        log: { error: vi.fn() } as never,
      });

      const send = refs.inputCard.querySelector('slicc-send-button');
      expect(send?.getAttribute('src')).toBe('https://avatars.example/lars.png');
      expect(refs.avatarMenu.querySelector('slicc-avatar')?.getAttribute('src')).toBe(
        'https://avatars.example/lars.png'
      );
    } finally {
      localStorage.removeItem('slicc_accounts');
    }
  });

  it('dispatches tray-leave with a worker URL on tray-stop', async () => {
    const refs = makeRefs();
    const client = makeClient();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });

    const events: CustomEvent[] = [];
    window.addEventListener('slicc:tray-leave', (e) => events.push(e as CustomEvent));
    refs.avatarMenu.dispatchEvent(
      new CustomEvent('slicc-avatar-action', { bubbles: true, detail: { id: 'tray-stop' } })
    );
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ workerBaseUrl: null });
  });

  it('routes slicc-error-open-settings from the thread to the settings dialog', async () => {
    const refs = makeRefs();
    const client = makeClient();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });

    showWcSettingsSpy.mockClear();
    refs.thread.dispatchEvent(
      new CustomEvent('slicc-error-open-settings', {
        detail: { messageId: 'err-1' },
        bubbles: true,
        composed: true,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showWcSettingsSpy).toHaveBeenCalledTimes(1);
  });

  it('routes the slicc:open-settings-from-panel window event to the settings dialog', async () => {
    const refs = makeRefs();
    const client = makeClient();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });

    showWcSettingsSpy.mockClear();
    window.dispatchEvent(new CustomEvent('slicc:open-settings-from-panel'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showWcSettingsSpy).toHaveBeenCalledTimes(1);
  });

  it('opens the same settings dialog for the composer-meta add-ai action', async () => {
    const refs = makeRefs();
    const client = makeClient();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });

    showWcSettingsSpy.mockClear();
    refs.composerMeta.dispatchEvent(new CustomEvent('add-ai', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showWcSettingsSpy).toHaveBeenCalledTimes(1);
  });

  it('opens the composer model picker on slicc-error-change-model from the thread', async () => {
    const refs = makeRefs();
    const client = makeClient();
    const openMenu = vi.fn();
    (refs.composerMeta as HTMLElement & { openMenu?: () => void }).openMenu = openMenu;
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });

    (refs.composerMeta as HTMLElement & { models?: unknown[] }).models = [
      { name: 'Opus 4.8', provider: 'Anthropic', id: 'anthropic:claude-opus-4-8' },
    ];

    refs.thread.dispatchEvent(
      new CustomEvent('slicc-error-change-model', {
        bubbles: true,
        composed: true,
        detail: { messageId: 'err-1' },
      })
    );
    expect(openMenu).toHaveBeenCalledTimes(1);
  });

  it('auto-replays the failed turn on the NEXT model-change after change-model', async () => {
    const refs = makeRefs();
    const client = makeClient();
    (refs.composerMeta as HTMLElement & { openMenu?: () => void }).openMenu = vi.fn();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });
    (refs.composerMeta as HTMLElement & { models?: unknown[] }).models = [
      { name: 'Opus 4.8', provider: 'Anthropic', id: 'anthropic:claude-opus-4-8' },
    ];

    const retries: CustomEvent[] = [];
    refs.thread.addEventListener('slicc-error-retry', (e) => retries.push(e as CustomEvent));

    refs.thread.dispatchEvent(
      new CustomEvent('slicc-error-change-model', {
        bubbles: true,
        composed: true,
        detail: { messageId: 'err-im' },
      })
    );
    expect(retries).toHaveLength(0);

    refs.composerMeta.dispatchEvent(
      new CustomEvent('model-change', {
        bubbles: true,
        detail: { id: 'adobe:claude-opus-4-7' },
      })
    );
    expect(retries).toHaveLength(1);
    expect(retries[0].detail).toEqual({ messageId: 'err-im' });
    expect(retries[0].bubbles).toBe(true);
    expect(retries[0].composed).toBe(true);

    refs.composerMeta.dispatchEvent(
      new CustomEvent('model-change', {
        bubbles: true,
        detail: { id: 'adobe:claude-sonnet-4-6' },
      })
    );
    expect(retries).toHaveLength(1);
  });

  it('routes change-model to settings when there are no models yet (no accounts)', async () => {
    const refs = makeRefs();
    const client = makeClient();
    (refs.composerMeta as HTMLElement & { models?: unknown[] }).models = [];
    const openMenu = vi.fn();
    (refs.composerMeta as HTMLElement & { openMenu?: () => void }).openMenu = openMenu;
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });

    refs.thread.dispatchEvent(
      new CustomEvent('slicc-error-change-model', {
        bubbles: true,
        composed: true,
        detail: { messageId: 'err-1' },
      })
    );

    expect(openMenu).not.toHaveBeenCalled();
  });

  it('re-opens the SELECTED provider (not the avatar account) on slicc-error-login', async () => {
    const adobeLogin = vi.fn(async (_launcher, onSuccess: () => void, _options) => {
      onSuccess();
    });
    const githubLogin = vi.fn(async (_launcher, onSuccess: () => void, _options) => {
      onSuccess();
    });
    registerProviderConfig({
      id: 'adobe',
      name: 'Adobe',
      description: 'Adobe test provider',
      requiresApiKey: false,
      requiresBaseUrl: false,
      onOAuthLogin: adobeLogin,
    });
    registerProviderConfig({
      id: 'github',
      name: 'GitHub',
      description: 'GitHub test provider',
      requiresApiKey: false,
      requiresBaseUrl: false,
      onOAuthLogin: githubLogin,
    });
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([
        {
          providerId: 'github',
          apiKey: '',
          userName: 'Lars Trieloff',
          userAvatar: 'https://avatars.example/lars.png',
          accessToken: 'gh',
        },
        { providerId: 'adobe', apiKey: '', userName: 'Lars', accessToken: 'tok' },
      ])
    );

    localStorage.setItem('selected-model', 'adobe:claude-opus-4-8');
    try {
      const refs = makeRefs();
      const client = makeClient();
      await wireWcNav({
        refs,
        client,
        workUnits: workUnitsOver(client),
        getUnits: () => coneSummaries(),
        log: { error: vi.fn() } as never,
      });

      refs.thread.dispatchEvent(
        new CustomEvent('slicc-error-login', {
          detail: { messageId: 'err-login' },
          bubbles: true,
          composed: true,
        })
      );

      for (let i = 0; i < 50 && adobeLogin.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(adobeLogin).toHaveBeenCalledTimes(1);

      expect(githubLogin).not.toHaveBeenCalled();

      expect(adobeLogin.mock.calls[0][2]).toEqual({ forceReauth: true });

      expect(client.updateModel).toHaveBeenCalledTimes(1);
    } finally {
      localStorage.removeItem('slicc_accounts');
      localStorage.removeItem('selected-model');
      unregisterProviderConfig('adobe');
      unregisterProviderConfig('github');
    }
  });

  it('falls back to settings on slicc-error-login when the selected provider has no OAuth config', async () => {
    registerProviderConfig({
      id: 'openai-test',
      name: 'OpenAI Test',
      description: 'API-key-only test provider',
      requiresApiKey: true,
      requiresBaseUrl: false,
    });
    localStorage.setItem('selected-model', 'openai-test:gpt-5');
    localStorage.removeItem('slicc_accounts');
    try {
      const refs = makeRefs();
      const client = makeClient();
      await wireWcNav({
        refs,
        client,
        workUnits: workUnitsOver(client),
        getUnits: () => coneSummaries(),
        log: { error: vi.fn() } as never,
      });

      showWcSettingsSpy.mockClear();
      refs.thread.dispatchEvent(
        new CustomEvent('slicc-error-login', {
          detail: { messageId: 'err-login' },
          bubbles: true,
          composed: true,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(showWcSettingsSpy).toHaveBeenCalledTimes(1);
    } finally {
      localStorage.removeItem('selected-model');
      unregisterProviderConfig('openai-test');
    }
  });

  it('updates the model-pill label when accounts change after Adobe OAuth', async () => {
    registerProviderConfig({
      id: 'adobe-pill-test',
      name: 'Adobe',
      description: 'Adobe test provider',
      requiresApiKey: false,
      requiresBaseUrl: false,
      isOAuth: true,
      defaultModelId: 'sonnet',
    });
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'adobe-pill-test', apiKey: '', accessToken: 'tok' }])
    );
    localStorage.setItem('selected-model', 'adobe-pill-test:claude-sonnet-4-6');
    try {
      const refs = makeRefs();
      const client = makeClient();
      await wireWcNav({
        refs,
        client,
        workUnits: workUnitsOver(client),
        getUnits: () => coneSummaries(),
        log: { error: vi.fn() } as never,
      });

      refs.composerMeta.setAttribute('model', 'Claude Haiku 3.5');

      await new Promise((resolve) => setTimeout(resolve, 0));

      window.dispatchEvent(new Event('slicc:accounts-changed'));

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(refs.composerMeta.getAttribute('model')).not.toBe('Claude Haiku 3.5');
    } finally {
      localStorage.removeItem('slicc_accounts');
      localStorage.removeItem('selected-model');
      unregisterProviderConfig('adobe-pill-test');
    }
  });
});

describe('session-sharing entry points', () => {
  const JOIN_URL = 'https://tray.example.com/join/tok';

  function makeRefs(): WcShellRefs {
    const composerMeta = document.createElement('slicc-composer-meta');
    const avatarMenu = document.createElement('slicc-avatar-menu');
    avatarMenu.append(document.createElement('slicc-avatar'));
    const inputCard = document.createElement('slicc-input-card');
    inputCard.append(document.createElement('slicc-send-button'));
    const thread = document.createElement('slicc-chat-thread');
    const floatbar = document.createElement('slicc-floatbar');
    document.body.append(composerMeta, avatarMenu, inputCard, thread, floatbar);
    return { composerMeta, avatarMenu, inputCard, thread, floatbar } as unknown as WcShellRefs;
  }

  async function wire(): Promise<WcShellRefs> {
    const refs = makeRefs();
    const client = makeClient();
    await wireWcNav({
      refs,
      client,
      workUnits: workUnitsOver(client),
      getUnits: () => coneSummaries(),
      log: { error: vi.fn() } as never,
    });
    return refs;
  }

  afterEach(() => {
    showSyncEnabledDialogSpy.mockClear();
    copyTextToClipboardSpy.mockClear();
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
    document.body.replaceChildren();
  });

  it('opens the dialog on its Status tab from the floatbar, without touching the clipboard', async () => {
    setLeaderTrayRuntimeStatus({
      state: 'leader',
      session: { joinUrl: JOIN_URL } as never,
      error: null,
    });
    const refs = await wire();

    refs.floatbar.dispatchEvent(
      new CustomEvent('slicc-followers-click', { bubbles: true, composed: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(copyTextToClipboardSpy).not.toHaveBeenCalled();
    expect(showSyncEnabledDialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ joinUrl: JOIN_URL, copied: false, initialTab: 'status' })
    );
  });

  it('copies the link when the avatar menu asks for it', async () => {
    setLeaderTrayRuntimeStatus({
      state: 'leader',
      session: { joinUrl: JOIN_URL } as never,
      error: null,
    });
    const refs = await wire();

    refs.avatarMenu.dispatchEvent(
      new CustomEvent('slicc-avatar-action', { detail: { id: 'tray-copy' } })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(copyTextToClipboardSpy).toHaveBeenCalledWith(JOIN_URL);
    expect(showSyncEnabledDialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ copied: true, initialTab: undefined })
    );
  });

  it('does nothing when there is no join link to share', async () => {
    const refs = await wire();
    refs.floatbar.dispatchEvent(
      new CustomEvent('slicc-followers-click', { bubbles: true, composed: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showSyncEnabledDialogSpy).not.toHaveBeenCalled();
  });
});
