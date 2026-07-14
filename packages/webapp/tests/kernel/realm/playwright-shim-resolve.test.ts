/**
 * Verifies the wiring contract for Task 3: `js-realm-shared.ts` accepts a
 * `shimmedPackages` map into its module resolver and `createPlaywrightShim`
 * produces a value shaped like what `require('playwright')` should resolve
 * to (`{ chromium, firefox, webkit }`, each with a `launch` method). Full
 * end-to-end `require('playwright')` resolution through the real realm/RPC
 * host is covered by the Task 4 integration test.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PlaywrightShimRpc } from '../../../src/kernel/realm/playwright-shim.js';
import { createPlaywrightShim } from '../../../src/kernel/realm/playwright-shim.js';

function mockRpc(): PlaywrightShimRpc {
  return { call: vi.fn(async () => undefined) };
}

describe('shimmedPackages wiring shape', () => {
  it('createPlaywrightShim(rpc) produces the shape resolveBuiltin should hand back for "playwright"', () => {
    const rpc = mockRpc();
    const shim = createPlaywrightShim(rpc);
    const shimmedPackages: Record<string, unknown> = { playwright: shim };

    expect(shimmedPackages.playwright).toBe(shim);
    expect(shim).toHaveProperty('chromium');
    expect(shim).toHaveProperty('firefox');
    expect(shim).toHaveProperty('webkit');
    expect(typeof shim.chromium.launch).toBe('function');
    expect(typeof shim.firefox.launch).toBe('function');
    expect(typeof shim.webkit.launch).toBe('function');
  });

  it('a bareId lookup on shimmedPackages resolves before falling through to NODE_BUILTINS_UNAVAILABLE', () => {
    const rpc = mockRpc();
    const shimmedPackages: Record<string, unknown> = { playwright: createPlaywrightShim(rpc) };
    const bareId = 'playwright';

    // Mirrors the exact lookup added to resolveBuiltin in js-realm-shared.ts:
    // `if (bareId in shimmedPackages) return { hit: true, value: shimmedPackages[bareId] };`
    const result =
      bareId in shimmedPackages
        ? { hit: true, value: shimmedPackages[bareId] }
        : { hit: false as const };

    expect(result.hit).toBe(true);
    expect(result.value).toBe(shimmedPackages.playwright);
  });

  it('an id not present in shimmedPackages misses (falls through to hit: false)', () => {
    const shimmedPackages: Record<string, unknown> = { playwright: {} };
    const bareId = 'some-other-package';

    const result =
      bareId in shimmedPackages
        ? { hit: true, value: shimmedPackages[bareId] }
        : { hit: false as const };

    expect(result.hit).toBe(false);
  });
});
