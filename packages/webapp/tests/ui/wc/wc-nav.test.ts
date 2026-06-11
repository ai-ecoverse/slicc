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
import { modelListForMeta, wireWcNav } from '../../../src/ui/wc/wc-nav.js';
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

describe('wireWcNav', () => {
  function makeRefs(): WcShellRefs {
    const composerMeta = document.createElement('slicc-composer-meta');
    const avatarMenu = document.createElement('slicc-avatar-menu');
    document.body.append(composerMeta, avatarMenu);
    return { composerMeta, avatarMenu } as unknown as WcShellRefs;
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
