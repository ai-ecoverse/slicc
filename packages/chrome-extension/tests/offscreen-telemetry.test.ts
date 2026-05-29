/**
 * Regression guard: the offscreen document MUST call `initTelemetry()` so
 * RUM beacons fire from the agent's bash tool (which runs in the offscreen
 * realm). Without this, `trackShellCommand` calls are silent no-ops because
 * `sampleRUM` is module-level singleton state that's per-realm.
 *
 * This is a static-text guard, not a behavior test — offscreen.ts has a long
 * side-effect-driven boot sequence (CDP proxy, kernel host, provider
 * registration) that's expensive to mock in isolation. Behavior of
 * initTelemetry itself is covered by webapp/tests/ui/telemetry.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const offscreenPath = join(here, '..', 'src', 'offscreen.ts');
const source = readFileSync(offscreenPath, 'utf8');

describe('offscreen.ts telemetry wiring', () => {
  it('imports initTelemetry from the webapp telemetry module', () => {
    expect(source).toMatch(
      /import\s+\{\s*initTelemetry\s*\}\s+from\s+['"][^'"]*\/ui\/telemetry\.js['"]/
    );
  });

  it('calls initTelemetry() inside init() with a swallowed catch', () => {
    expect(source).toMatch(/initTelemetry\(\)\s*\.catch\(/);
  });

  it('calls initTelemetry before the heavy boot (registerProviders)', () => {
    const initIdx = source.indexOf('initTelemetry()');
    const providersIdx = source.indexOf('await registerProviders');
    expect(initIdx).toBeGreaterThan(-1);
    expect(providersIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeLessThan(providersIdx);
  });
});
