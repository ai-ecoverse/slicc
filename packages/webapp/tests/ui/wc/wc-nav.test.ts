// @vitest-environment jsdom
/**
 * Nav wiring tests: the model-picker mapper, the avatar-menu tray section,
 * and the live wiring against a fake client.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

// Capture the dialog-open invocations so we can assert that the bubbled
// `slicc-error-open-settings` event routes the user into the same surface
// as the composer-meta `add-ai` action — without booting the real dialog.
const showWcSettingsSpy = vi.fn(async () => undefined);
vi.mock('../../../src/ui/wc/wc-settings.js', () => ({ showWcSettings: showWcSettingsSpy }));

import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import type { GroupedModels } from '../../../src/ui/provider-settings.js';
import { accountIdentity, modelListForMeta, wireWcNav } from '../../../src/ui/wc/wc-nav.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';

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

describe('wireWcNav', () => {
  function makeRefs(): WcShellRefs {
    const composerMeta = document.createElement('slicc-composer-meta');
    const avatarMenu = document.createElement('slicc-avatar-menu');
    avatarMenu.append(document.createElement('slicc-avatar'));
    const inputCard = document.createElement('slicc-input-card');
    inputCard.append(document.createElement('slicc-send-button'));
    const thread = document.createElement('slicc-chat-thread');
    document.body.append(composerMeta, avatarMenu, inputCard, thread);
    return { composerMeta, avatarMenu, inputCard, thread } as unknown as WcShellRefs;
  }

  it('feeds the model picker, persists selection, and wires the menu', async () => {
    const refs = makeRefs();
    const client = { updateModel: vi.fn() } as unknown as OffscreenClient;
    await wireWcNav({ refs, client, log: { error: vi.fn() } as never });

    // Models list assigned (registry may be empty under test — array either way).
    expect(Array.isArray((refs.composerMeta as HTMLElement & { models?: unknown }).models)).toBe(
      true
    );
    expect(refs.avatarMenu.items.some((i) => i.id === 'settings')).toBe(true);
    // Tray section present (leader-offer in a dormant runtime).
    expect(refs.avatarMenu.items.some((i) => i.id === 'tray-enable')).toBe(true);

    refs.composerMeta.dispatchEvent(
      new CustomEvent('model-change', {
        bubbles: true,
        detail: { id: 'adobe:claude-opus-4-8' },
      })
    );
    // The picker emits a provider-qualified id; the handler must persist it
    // unchanged so `getSelectedProvider()` recovers the correct provider.
    expect(localStorage.getItem('selected-model')).toBe('adobe:claude-opus-4-8');
    expect(client.updateModel).toHaveBeenCalledTimes(1);
  });

  it('clears the avatar identity when signed out (so the component shows ?)', async () => {
    const refs = makeRefs();
    // Seed a stale name as if a previous render had set one.
    const avatar = refs.avatarMenu.querySelector('slicc-avatar') as HTMLElement;
    avatar.setAttribute('name', 'SLICC');
    avatar.setAttribute('src', 'https://stale.example/old.png');
    const client = { updateModel: vi.fn() } as unknown as OffscreenClient;
    await wireWcNav({ refs, client, log: { error: vi.fn() } as never });

    // The host strips identity so the avatar component falls back to its `?`
    // placeholder (the glyph itself is asserted in slicc-avatar.test.ts).
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
      const client = { updateModel: vi.fn() } as unknown as OffscreenClient;
      await wireWcNav({ refs, client, log: { error: vi.fn() } as never });

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
    const client = { updateModel: vi.fn() } as unknown as OffscreenClient;
    await wireWcNav({ refs, client, log: { error: vi.fn() } as never });

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
    const client = { updateModel: vi.fn() } as unknown as OffscreenClient;
    await wireWcNav({ refs, client, log: { error: vi.fn() } as never });

    showWcSettingsSpy.mockClear();
    refs.thread.dispatchEvent(
      new CustomEvent('slicc-error-open-settings', {
        detail: { messageId: 'err-1' },
        bubbles: true,
        composed: true,
      })
    );
    // The handler dynamically imports the settings dialog; wait a microtask
    // tick for the import to resolve before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showWcSettingsSpy).toHaveBeenCalledTimes(1);
  });

  it('opens the same settings dialog for the composer-meta add-ai action', async () => {
    const refs = makeRefs();
    const client = { updateModel: vi.fn() } as unknown as OffscreenClient;
    await wireWcNav({ refs, client, log: { error: vi.fn() } as never });

    showWcSettingsSpy.mockClear();
    refs.composerMeta.dispatchEvent(new CustomEvent('add-ai', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showWcSettingsSpy).toHaveBeenCalledTimes(1);
  });

  it('opens the composer model picker on slicc-error-change-model from the thread', async () => {
    const refs = makeRefs();
    const client = { updateModel: vi.fn() } as unknown as OffscreenClient;
    const openMenu = vi.fn();
    (refs.composerMeta as HTMLElement & { openMenu?: () => void }).openMenu = openMenu;
    await wireWcNav({ refs, client, log: { error: vi.fn() } as never });
    // `wireWcNav` resets `models` from the (empty) provider registry; seed
    // AFTER it runs so the handler sees a non-empty list and routes to the
    // picker rather than to settings.
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
    const client = { updateModel: vi.fn() } as unknown as OffscreenClient;
    (refs.composerMeta as HTMLElement & { openMenu?: () => void }).openMenu = vi.fn();
    await wireWcNav({ refs, client, log: { error: vi.fn() } as never });
    (refs.composerMeta as HTMLElement & { models?: unknown[] }).models = [
      { name: 'Opus 4.8', provider: 'Anthropic', id: 'anthropic:claude-opus-4-8' },
    ];

    const retries: CustomEvent[] = [];
    refs.thread.addEventListener('slicc-error-retry', (e) => retries.push(e as CustomEvent));

    // (1) User clicks Change-model on the error card — stamps the failed id.
    refs.thread.dispatchEvent(
      new CustomEvent('slicc-error-change-model', {
        bubbles: true,
        composed: true,
        detail: { messageId: 'err-im' },
      })
    );
    expect(retries).toHaveLength(0);

    // (2) User picks a new model — the picker emits model-change. The next
    // change consumes the staged retry id and fires slicc-error-retry.
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

    // (3) A subsequent model-change with no pending retry does NOT re-fire.
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
    const client = { updateModel: vi.fn() } as unknown as OffscreenClient;
    (refs.composerMeta as HTMLElement & { models?: unknown[] }).models = [];
    const openMenu = vi.fn();
    (refs.composerMeta as HTMLElement & { openMenu?: () => void }).openMenu = openMenu;
    await wireWcNav({ refs, client, log: { error: vi.fn() } as never });

    refs.thread.dispatchEvent(
      new CustomEvent('slicc-error-change-model', {
        bubbles: true,
        composed: true,
        detail: { messageId: 'err-1' },
      })
    );
    // No menu open in the no-accounts state — the host should drop the user
    // into account settings instead (asserted indirectly via openMenu staying
    // untouched; the settings-dialog import is dynamic and exercised in the
    // settings-wiring tests).
    expect(openMenu).not.toHaveBeenCalled();
  });
});
