// @vitest-environment jsdom
/**
 * Nav wiring tests: the model-picker mapper, the avatar-menu tray section,
 * and the live wiring against a fake client.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import type { GroupedModels } from '../../../src/ui/provider-settings.js';
import { accountIdentity, modelListForMeta, wireWcNav } from '../../../src/ui/wc/wc-nav.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';

describe('modelListForMeta', () => {
  it('flattens provider groups into picker rows', () => {
    const groups = [
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        models: [{ id: 'claude-opus-4-8', name: 'Opus 4.8' }, { id: 'claude-haiku-4-5' }],
      },
      { providerId: 'openai', providerName: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
    ] as unknown as GroupedModels[];
    expect(modelListForMeta(groups)).toEqual([
      { name: 'Opus 4.8', provider: 'Anthropic', id: 'claude-opus-4-8' },
      { name: 'claude-haiku-4-5', provider: 'Anthropic', id: 'claude-haiku-4-5' },
      { name: 'GPT-5', provider: 'OpenAI', id: 'gpt-5' },
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
    document.body.append(composerMeta, avatarMenu, inputCard);
    return { composerMeta, avatarMenu, inputCard } as unknown as WcShellRefs;
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
      new CustomEvent('model-change', { bubbles: true, detail: { id: 'claude-opus-4-8' } })
    );
    expect(localStorage.getItem('selected-model')).toBe('claude-opus-4-8');
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
});
