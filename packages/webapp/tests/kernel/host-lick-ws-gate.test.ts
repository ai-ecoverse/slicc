import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Static, not `await import()` inside each test: `src/kernel/host.js` pulls a
// large graph, and vitest charges that transform+evaluation to whichever test
// triggers it — the first one here measured >1.2s of a 5s budget and timed out
// under load. Both gates below read `globalThis.chrome` / the delegate id at
// CALL time (`resolveFloatTopology`), never at module scope, so importing
// ahead of the per-test global stubbing is behaviour-preserving.
import { shouldStartLickWsBridge } from '../../src/kernel/host.js';
import { setExtensionDelegateId } from '../../src/shell/proxied-fetch.js';

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
    setExtensionDelegateId(null);
  });

  it('starts the bridge for node-rest', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    setExtensionDelegateId(null);
    expect(shouldStartLickWsBridge()).toBe(true);
  });

  it('does NOT start the bridge for extension-delegate', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => undefined } };
    setExtensionDelegateId('delegate-id');
    expect(shouldStartLickWsBridge()).toBe(false);
  });

  it('does NOT start the bridge for extension-direct', async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'real-ext-id' } };
    setExtensionDelegateId(null);
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
