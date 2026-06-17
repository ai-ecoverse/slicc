/**
 * Regression guard: `ui/main.ts` MUST call `initTelemetry()` so RUM beacons
 * fire from the page/panel realm. Without this, `viewblock` (sprinkles),
 * `signup` (settings), panel JS `error`, and `trackChatSubmit` are silent
 * no-ops because `sampleRUM` is module-level singleton state per-realm.
 *
 * Static-text guard, not a behavior test — main.ts has a long async boot
 * sequence (SW registration, provider registration, OAuth bootstrap) that's
 * expensive to mock. Behavior of `initTelemetry` itself is covered by
 * `webapp/tests/ui/telemetry.test.ts`. Mirrors
 * `chrome-extension/tests/offscreen-telemetry.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mainPath = join(here, '..', '..', 'src', 'ui', 'main.ts');
const source = readFileSync(mainPath, 'utf8');

describe('ui/main.ts telemetry wiring', () => {
  it('imports initTelemetry from the telemetry module', () => {
    expect(source).toMatch(/import\s+\{\s*initTelemetry\s*\}\s+from\s+['"]\.\/telemetry\.js['"]/);
  });

  it('calls initTelemetry() with a swallowed catch', () => {
    expect(source).toMatch(/initTelemetry\(\)\s*\.catch\(/);
  });

  it('calls initTelemetry after the fixture early-return', () => {
    const fixtureIdx = source.indexOf('isFixtureRequested(window.location.href)');
    const initIdx = source.indexOf('initTelemetry()');
    expect(fixtureIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(fixtureIdx);
  });

  it('calls initTelemetry before the heavy boot (registerProviders)', () => {
    const initIdx = source.indexOf('initTelemetry()');
    const providersIdx = source.indexOf('await registerProviders');
    expect(initIdx).toBeGreaterThan(-1);
    expect(providersIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeLessThan(providersIdx);
  });

  it('gates initTelemetry on a non-connect runtime mode', () => {
    expect(source).toMatch(/runtimeMode\s*!==\s*['"]connect['"][\s\S]{0,200}initTelemetry\(\)/);
  });
});
