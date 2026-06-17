/**
 * Regression guard: the standalone kernel-worker DedicatedWorker MUST call
 * `initTelemetry()` during boot so RUM beacons fire from the worker
 * AlmostBashShell and uncaught errors in the agent loop are captured.
 * Without this, `trackShellCommand` / `trackError` are silent no-ops because
 * `sampleRUM` is per-realm module state.
 *
 * Static-text guard — boot side effects are exercised end-to-end by the
 * existing kernel-worker init-guard and fetch-bypass tests; this just pins
 * the call site so a refactor cannot regress the wiring.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, '..', '..', 'src', 'kernel', 'kernel-worker.ts');
const source = readFileSync(workerPath, 'utf8');

describe('kernel-worker.ts telemetry wiring', () => {
  it('imports initTelemetry from the webapp telemetry module', () => {
    expect(source).toMatch(
      /import\s+\{\s*initTelemetry\s*\}\s+from\s+['"][^'"]*\/ui\/telemetry\.js['"]/
    );
  });

  it('calls initTelemetry exactly once in the module', () => {
    const matches = source.match(/initTelemetry\(\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('calls initTelemetry AFTER installLocalStorageShim so seeded keys propagate', () => {
    // The page seeds `telemetry-disabled` and `slicc-rum-debug` into
    // `localStorageSeed`; initTelemetry reads them via the worker's Map-backed
    // shim, which is installed by installLocalStorageShim. Ordering is
    // load-bearing — initTelemetry running before the shim would always see
    // an undefined localStorage and skip the disable check.
    const shimIdx = source.indexOf('installLocalStorageShim(init.localStorageSeed');
    const telemIdx = source.indexOf('initTelemetry()');
    expect(shimIdx).toBeGreaterThan(-1);
    expect(telemIdx).toBeGreaterThan(-1);
    expect(telemIdx).toBeGreaterThan(shimIdx);
  });

  it('calls initTelemetry BEFORE createKernelHost so beacons cover host construction errors', () => {
    const telemIdx = source.indexOf('initTelemetry()');
    // Match the actual factory call (`await createKernelHost(`), not the
    // import statement or the `Awaited<ReturnType<typeof createKernelHost>>`
    // type alias both of which appear earlier in the module.
    const hostIdx = source.indexOf('await createKernelHost(');
    expect(telemIdx).toBeGreaterThan(-1);
    expect(hostIdx).toBeGreaterThan(-1);
    expect(telemIdx).toBeLessThan(hostIdx);
  });

  it('swallows initTelemetry rejection so a telemetry failure cannot block boot', () => {
    // Match the same `.catch(() => {})` discipline used by offscreen.ts so
    // a transient rum-worker.js import / fetch failure does not break the
    // worker boot sequence.
    expect(source).toMatch(/initTelemetry\(\)\s*\.catch\(/);
  });
});
