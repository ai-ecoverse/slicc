import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('resolveFloatTopology + hasLocalNodeServer', () => {
  let originalChrome: unknown;
  let originalConnectMode: unknown;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalConnectMode = (globalThis as Record<string, unknown>).__slicc_connect_mode;
  });

  afterEach(async () => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = originalConnectMode;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
  });

  it('returns extension-direct when chrome.runtime.id is truthy', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'real-ext-id' } };
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('delegate-id');
    const { resolveFloatTopology, hasLocalNodeServer } = await import(
      '../../src/core/float-topology.js'
    );
    expect(resolveFloatTopology()).toBe('extension-direct');
    expect(hasLocalNodeServer()).toBe(false);
  });

  it('returns extension-delegate when a delegate id is set (no runtime.id)', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => undefined } };
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('delegate-id');
    const { resolveFloatTopology, hasLocalNodeServer } = await import(
      '../../src/core/float-topology.js'
    );
    expect(resolveFloatTopology()).toBe('extension-delegate');
    expect(hasLocalNodeServer()).toBe(false);
  });

  it('returns connect when __slicc_connect_mode is set and no delegate id', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = true;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { resolveFloatTopology, hasLocalNodeServer } = await import(
      '../../src/core/float-topology.js'
    );
    expect(resolveFloatTopology()).toBe('connect');
    expect(hasLocalNodeServer()).toBe(false);
  });

  it('returns node-rest by default and hasLocalNodeServer is true only then', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = undefined;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { resolveFloatTopology, hasLocalNodeServer } = await import(
      '../../src/core/float-topology.js'
    );
    expect(resolveFloatTopology()).toBe('node-rest');
    expect(hasLocalNodeServer()).toBe(true);
  });

  it('secret-topology re-export resolves identically', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as Record<string, unknown>).__slicc_connect_mode = undefined;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { resolveSecretTopology } = await import('../../src/core/secret-topology.js');
    const { resolveFloatTopology } = await import('../../src/core/float-topology.js');
    expect(resolveSecretTopology()).toBe(resolveFloatTopology());
  });
});
