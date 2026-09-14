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
      /import\s+\{[^}]*\binitTelemetry\b[^}]*\}\s+from\s+['"][^'"]*\/telemetry\.js['"]/
    );
  });

  it('calls initTelemetry exactly once in the module', () => {
    const matches = source.match(/initTelemetry\(\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('calls initTelemetry AFTER installLocalStorageShim so seeded keys propagate', () => {
    const shimIdx = source.indexOf('installLocalStorageShim(init.localStorageSeed');
    const telemIdx = source.indexOf('initTelemetry()');
    expect(shimIdx).toBeGreaterThan(-1);
    expect(telemIdx).toBeGreaterThan(-1);
    expect(telemIdx).toBeGreaterThan(shimIdx);
  });

  it('calls initTelemetry BEFORE createKernelHost so beacons cover host construction errors', () => {
    const telemIdx = source.indexOf('initTelemetry()');

    const hostIdx = source.indexOf('await createKernelHost(');
    expect(telemIdx).toBeGreaterThan(-1);
    expect(hostIdx).toBeGreaterThan(-1);
    expect(telemIdx).toBeLessThan(hostIdx);
  });

  it('swallows initTelemetry rejection so a telemetry failure cannot block boot', () => {
    expect(source).toMatch(/initTelemetry\(\)[\s\S]*?\.catch\(/);
  });
});
