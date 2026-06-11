// @vitest-environment jsdom
/**
 * Nav wiring tests: the model-picker mapper, the legacy-UI escape hatch,
 * and the live wiring against a fake client.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import type { GroupedModels } from '../../../src/ui/provider-settings.js';
import { legacyUiUrl, modelListForMeta, wireWcNav } from '../../../src/ui/wc/wc-nav.js';
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

describe('legacyUiUrl', () => {
  it('strips the ui flag, keeping the rest of the query', () => {
    expect(legacyUiUrl('http://localhost:5710/?ui=wc&x=1')).toBe('http://localhost:5710/?x=1');
    expect(legacyUiUrl('http://localhost:5710/?ui=wc')).toBe('http://localhost:5710/');
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
    const navigate = vi.fn();
    await wireWcNav({ refs, client, log: { error: vi.fn() } as never, navigate });

    // Models list assigned (registry may be empty under test — array either way).
    expect(Array.isArray((refs.composerMeta as HTMLElement & { models?: unknown }).models)).toBe(
      true
    );
    expect(refs.avatarMenu.items.some((i) => i.id === 'settings')).toBe(true);

    refs.composerMeta.dispatchEvent(
      new CustomEvent('model-change', { bubbles: true, detail: { id: 'claude-opus-4-8' } })
    );
    expect(localStorage.getItem('selected-model')).toBe('claude-opus-4-8');
    expect(client.updateModel).toHaveBeenCalledTimes(1);

    refs.avatarMenu.dispatchEvent(
      new CustomEvent('slicc-avatar-action', { bubbles: true, detail: { id: 'legacy-ui' } })
    );
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).not.toContain('ui=wc');
  });
});
