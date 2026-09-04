import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Static, not `await import()` inside each test: `src/kernel/host.js` pulls a
// large graph, and vitest charges that transform+evaluation to whichever test
// triggers it — the first one here measured >1.2s of a 5s budget and timed out
// under load.
import { shouldStartLickWsBridge } from '../../src/kernel/host.js';

describe('shouldStartLickWsBridge (kernel host lick-ws gate)', () => {
  // #2276 slice C: takes the already-resolved topology (`capabilityBroker.adapter`
  // in `bootOrchestrator`) as a parameter instead of re-probing
  // `hasLocalNodeServer()` itself, so this is a pure function over its input —
  // no more `globalThis.chrome` / extension-delegate-id stubbing needed.
  it('starts the bridge for node-rest', () => {
    expect(shouldStartLickWsBridge('node-rest')).toBe(true);
  });

  it('does NOT start the bridge for extension-delegate', () => {
    expect(shouldStartLickWsBridge('extension-delegate')).toBe(false);
  });

  it('does NOT start the bridge for extension-direct', () => {
    expect(shouldStartLickWsBridge('extension-direct')).toBe(false);
  });

  it('does NOT start the bridge for connect', () => {
    expect(shouldStartLickWsBridge('connect')).toBe(false);
  });
});

describe('host.ts lick-ws gate wiring (source)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '..', '..', 'src', 'kernel', 'host.ts'), 'utf8');

  it('guards startLickWsBridgeForHost with shouldStartLickWsBridge()', () => {
    // The bridge start is reached ONLY when the (unit-tested) predicate is true.
    expect(source).toMatch(
      /if \(shouldStartLickWsBridge\(capabilityBroker\.adapter\)\)\s*\{[\s\S]*?startLickWsBridgeForHost\(/
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
