/**
 * Regression guard: `ui/main.ts` MUST call `setupStoragePersistence()`.
 *
 * The module's own unit tests exercise the helper in isolation, so deleting
 * the call site would leave every one of them green while silently putting
 * SLICC's entire OPFS tree back on Chromium's eviction list — the failure
 * this whole feature exists to prevent, and one that shows up as total,
 * silent data loss weeks later on someone's full disk.
 *
 * Static-text guard, not a behavior test — `main.ts` has a long async boot
 * sequence (SW registration, provider registration, OAuth bootstrap) that is
 * expensive to mock. Behavior lives in
 * `webapp/tests/ui/boot/setup-storage-persistence.test.ts`. Mirrors
 * `webapp/tests/ui/main-telemetry.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mainPath = join(here, '..', '..', 'src', 'ui', 'main.ts');
const source = readFileSync(mainPath, 'utf8');

/**
 * Offset of the live call. Anchored to the start of a line so a
 * commented-out `// setupStoragePersistence();` cannot satisfy the ordering
 * assertions below — that is exactly the regression they exist to catch.
 */
const callIdx = source.search(/^  setupStoragePersistence\(\);$/m);

describe('ui/main.ts storage-persistence wiring', () => {
  it('imports setupStoragePersistence from the boot helper', () => {
    expect(source).toMatch(
      /import\s+\{\s*setupStoragePersistence\s*\}\s+from\s+['"]\.\/boot\/setup-storage-persistence\.js['"]/
    );
  });

  it('calls setupStoragePersistence()', () => {
    expect(callIdx).toBeGreaterThan(-1);
  });

  /** The fixture surface returns before boot; a call above it never runs. */
  it('calls setupStoragePersistence after the fixture early-return', () => {
    const fixtureIdx = source.indexOf('isFixtureRequested(window.location.href)');
    expect(fixtureIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(fixtureIdx);
  });

  /**
   * Ahead of the heavy boot so the request is in flight during it — the
   * grant matters most on the run where the disk is already tight.
   */
  it('calls setupStoragePersistence before the heavy boot (registerProviders)', () => {
    const providersIdx = source.indexOf('await registerProviders');
    expect(callIdx).toBeGreaterThan(-1);
    expect(providersIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(providersIdx);
  });

  /**
   * Every float shares the storage key, so the call must sit above the
   * follower / connect / extension dispatches rather than inside one branch.
   */
  it('calls setupStoragePersistence before the per-float dispatches', () => {
    // Anchored on the invocations, not the bare names — every one of these is
    // also mentioned in main.ts's leading docblock, above the call site.
    for (const dispatch of [
      'mountWcUiFollower(app',
      'mountConnectSurface(app',
      'mountWcUiExtension(app',
    ]) {
      const idx = source.indexOf(dispatch);
      expect(idx, `${dispatch} not found in main.ts`).toBeGreaterThan(-1);
      expect(callIdx, `setupStoragePersistence must run before ${dispatch}`).toBeLessThan(idx);
    }
  });

  /** `void`-returning by design — awaiting it would put boot behind it. */
  it('does not await setupStoragePersistence', () => {
    expect(source).not.toMatch(/await\s+setupStoragePersistence\(/);
  });
});
