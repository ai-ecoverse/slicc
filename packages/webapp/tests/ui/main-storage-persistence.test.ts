import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mainPath = join(here, '..', '..', 'src', 'ui', 'main.ts');
const source = readFileSync(mainPath, 'utf8');

const callIdx = source.search(/^ {2}setupStoragePersistence\(\);$/m);

describe('ui/main.ts storage-persistence wiring', () => {
  it('imports setupStoragePersistence from the boot helper', () => {
    expect(source).toMatch(
      /import\s+\{\s*setupStoragePersistence\s*\}\s+from\s+['"]\.\/boot\/setup-storage-persistence\.js['"]/
    );
  });

  it('calls setupStoragePersistence()', () => {
    expect(callIdx).toBeGreaterThan(-1);
  });

  it('calls setupStoragePersistence after the fixture early-return', () => {
    const fixtureIdx = source.indexOf('isFixtureRequested(window.location.href)');
    expect(fixtureIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(fixtureIdx);
  });

  it('calls setupStoragePersistence before the heavy boot (registerProviders)', () => {
    const providersIdx = source.indexOf('await registerProviders');
    expect(callIdx).toBeGreaterThan(-1);
    expect(providersIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(providersIdx);
  });

  it('calls setupStoragePersistence before the per-float dispatches', () => {
    for (const dispatch of [
      'bootFollowerFloat(app',
      'mountConnectSurface(app',
      'bootExtensionFloat(app',
    ]) {
      const idx = source.indexOf(dispatch);
      expect(idx, `${dispatch} not found in main.ts`).toBeGreaterThan(-1);
      expect(callIdx, `setupStoragePersistence must run before ${dispatch}`).toBeLessThan(idx);
    }
  });

  it('does not await setupStoragePersistence', () => {
    expect(source).not.toMatch(/await\s+setupStoragePersistence\(/);
  });
});
