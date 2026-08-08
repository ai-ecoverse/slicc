/**
 * Regression guards for worker-realm feature-flag adoption (#2003).
 *
 * The kernel worker must adopt the page's cached remote flag values
 * (`initFeatureFlagsFromRemoteCache(init.flagFloat)`) or remote-only
 * enablement is invisible in this realm — `isFeatureEnabled` would fall
 * back to the bundled default. Ordering is load-bearing: the cache
 * reader resolves `globalThis.localStorage` at call time, which in the
 * worker only exists after `installLocalStorageShim`.
 *
 * Static-text guards, mirroring `kernel-worker-telemetry.test.ts` —
 * boot side effects are exercised end-to-end by the init-guard tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, '..', '..', 'src', 'kernel', 'kernel-worker.ts');
const source = readFileSync(workerPath, 'utf8');

describe('kernel-worker.ts feature-flag adoption (#2003)', () => {
  it('adopts the page float remote flag cache', () => {
    expect(source).toMatch(/initFeatureFlagsFromRemoteCache\(init\.flagFloat\)/);
  });

  it('adopts flags AFTER the localStorage shim is installed', () => {
    const shimIdx = source.indexOf('installLocalStorageShim(init.localStorageSeed');
    const flagsIdx = source.indexOf('initFeatureFlagsFromRemoteCache(init.flagFloat)');
    expect(shimIdx).toBeGreaterThan(-1);
    expect(flagsIdx).toBeGreaterThan(-1);
    expect(shimIdx).toBeLessThan(flagsIdx);
  });
});
