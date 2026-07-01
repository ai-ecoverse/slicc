import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('shouldStartLickWsBridge (kernel host lick-ws gate)', () => {
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

  it('starts the bridge for node-rest', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { shouldStartLickWsBridge } = await import('../../src/kernel/host.js');
    expect(shouldStartLickWsBridge()).toBe(true);
  });

  it('does NOT start the bridge for extension-delegate', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => undefined } };
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('delegate-id');
    const { shouldStartLickWsBridge } = await import('../../src/kernel/host.js');
    expect(shouldStartLickWsBridge()).toBe(false);
  });

  it('does NOT start the bridge for extension-direct', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'real-ext-id' } };
    const { setExtensionDelegateId } = await import('../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    const { shouldStartLickWsBridge } = await import('../../src/kernel/host.js');
    expect(shouldStartLickWsBridge()).toBe(false);
  });
});

describe('host.ts lick-ws gate wiring (source)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '..', '..', 'src', 'kernel', 'host.ts'), 'utf8');

  it('guards startLickWsBridgeForHost with shouldStartLickWsBridge()', () => {
    // The bridge start is reached ONLY when the (unit-tested) predicate is true.
    expect(source).toMatch(
      /if \(shouldStartLickWsBridge\(\)\)\s*\{[\s\S]*?startLickWsBridgeForHost\(/
    );
  });

  it('fully retires the isExtension token (code AND doc comments)', () => {
    // \bisExtension\b matches the standalone flag (`isExtension?:`, `!isExtension`,
    // `isExtension = false`, and prose like `` `isExtension` ``) but NOT
    // `transport.isExtensionBridge` — the live signal the NavigationWatcher
    // self-skips on, which is intentionally kept.
    expect(source).not.toMatch(/\bisExtension\b/);
    expect(source).toContain('transport.isExtensionBridge');
  });

  it('calls the NavigationWatcher unconditionally (it self-skips on the transport)', () => {
    // Unwrapped call — startNavigationWatcherForHost bails on
    // transport.isExtensionBridge internally.
    expect(source).toMatch(/navigationWatcherStop[\s\S]*?startNavigationWatcherForHost\(/);
  });
});
