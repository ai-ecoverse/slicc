/**
 * `resolveSecretTopology()` precedence (EXT7 Design Contract §3.A).
 *
 * Four branches, first match wins:
 *   extension-direct → extension-delegate → connect → node-rest.
 * Critically, extension-delegate must beat node-rest even when a
 * `localApiBaseUrl` is also configured (resolves research Q#2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('resolveSecretTopology', () => {
  let originalChrome: unknown;
  let originalConnectMode: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalConnectMode = (globalThis as Record<string, unknown>).__slicc_connect_mode;
  });

  afterEach(async () => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = originalConnectMode;
    const { setExtensionDelegateId, setLocalApiBaseUrl } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setExtensionDelegateId(null);
    setLocalApiBaseUrl(null);
  });

  it('returns extension-direct when chrome.runtime.id is truthy', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'real-ext-id' } };
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    // Even with a delegate id set, the real-extension page wins.
    setExtensionDelegateId('delegate-id');
    const { resolveSecretTopology } = await import('../../src/core/secret-topology.js');
    expect(resolveSecretTopology()).toBe('extension-direct');
  });

  it('returns extension-delegate when a delegate id is set (no runtime.id)', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => undefined } };
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('delegate-id');
    const { resolveSecretTopology } = await import('../../src/core/secret-topology.js');
    expect(resolveSecretTopology()).toBe('extension-delegate');
  });

  it('extension-delegate beats node-rest even when localApiBaseUrl is set', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    const { setExtensionDelegateId, setLocalApiBaseUrl } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setExtensionDelegateId('delegate-id');
    setLocalApiBaseUrl('http://localhost:5710');
    const { resolveSecretTopology } = await import('../../src/core/secret-topology.js');
    expect(resolveSecretTopology()).toBe('extension-delegate');
  });

  it('returns connect when __slicc_connect_mode is set and no delegate id', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = true;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { resolveSecretTopology } = await import('../../src/core/secret-topology.js');
    expect(resolveSecretTopology()).toBe('connect');
  });

  it('returns node-rest by default (CLI / Electron / swift)', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = undefined;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { resolveSecretTopology } = await import('../../src/core/secret-topology.js');
    expect(resolveSecretTopology()).toBe('node-rest');
  });
});
