/**
 * Regression guard (slicc#4051): `ui/main.ts` MUST run the six-upgrade stop
 * step before any service worker registers and before any float boots, and
 * `wc-live.ts` must hand the kernel's teardown to it right after the spawn.
 * A six page that boots while seven's exporter runs would otherwise register
 * `llm-proxy-sw.js` at scope `/` over seven's service worker, or start a
 * kernel that writes the profile being read.
 *
 * Static-text guard like `main-storage-persistence.test.ts`; behaviour lives
 * in `six-upgrade-stop.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '..', '..', 'src', 'ui', 'main.ts'), 'utf8');
const live = readFileSync(join(here, '..', '..', 'src', 'ui', 'wc', 'wc-live.ts'), 'utf8');

const stopIdx = main.search(
  /^ {2}if \(!isExtension && \(await setupSixUpgradeStop\(document\)\)\) return;$/m
);

describe('ui/main.ts six-upgrade stop wiring', () => {
  it('stops booting when the stop step says so', () => {
    expect(stopIdx).toBeGreaterThan(-1);
  });

  it('runs before service-worker registration and every float dispatch', () => {
    for (const later of [
      'await setupSwRegistration(',
      'bootFollowerFloat(app',
      'mountConnectSurface(app',
      'bootLeaderFloat(app',
    ]) {
      const idx = main.indexOf(later);
      expect(idx, `${later} not found in main.ts`).toBeGreaterThan(-1);
      expect(stopIdx, `the stop step must run before ${later}`).toBeLessThan(idx);
    }
  });

  it('imports the step from its boot helper', () => {
    expect(main).toMatch(
      /import\s+\{\s*setupSixUpgradeStop\s*\}\s+from\s+['"]\.\/boot\/setup-six-upgrade-stop\.js['"]/
    );
  });
});

describe('ui/wc/wc-live.ts kernel teardown', () => {
  it('registers kernel.drain for the stop right after spawning the kernel', () => {
    const spawn = live.indexOf('kernel = spawnKernelWorker({');
    const register = live.indexOf('registerSixKernelStop(() => kernel.drain());');
    expect(spawn).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(spawn);
    expect(register).toBeLessThan(live.indexOf('installPageStorageSync(', spawn));
  });
});
