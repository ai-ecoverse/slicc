import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { shouldStartLickWsBridge } from '../../src/kernel/host.js';

describe('shouldStartLickWsBridge (kernel host lick-ws gate)', () => {
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
    expect(source).toMatch(
      /shouldStartLickWsBridge\(capabilityBroker\.adapter\)\s*\?\s*await startLickWsBridgeForHost\(/
    );
  });

  it('fully retires the isExtension token (code AND doc comments)', () => {
    expect(source).not.toMatch(/\bisExtension\b/);
    expect(source).toContain('transport.isExtensionBridge');
  });

  it('calls the NavigationWatcher unconditionally (it self-skips on the transport)', () => {
    expect(source).toMatch(/navigationWatcherStop[\s\S]*?startNavigationWatcherForHost\(/);
  });
});
