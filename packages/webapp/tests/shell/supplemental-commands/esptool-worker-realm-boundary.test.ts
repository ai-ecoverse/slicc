/**
 * Regression guard: the kernel-worker build must not ship esptool-js.
 *
 * Vite builds the worker as its own Rollup graph, so the local backend's
 * `import('../../kernel/esptool-operations.js')` in `esptool-backends.ts`
 * emitted a SECOND copy of esptool-js and every per-chip stub-flasher chunk,
 * unreachable in a worker (`LocalEsptoolBackend` is gated on `hasLocalDom()`).
 * The worker build swaps that module for a throwing stub
 * (`stubPageRealmEsptoolPlugin` in `vite.config.ts`).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as stub from '../../../src/stubs/esptool-page-realm-stub.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webappRoot = resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(webappRoot, rel), 'utf8');

const runtimeExports = (source: string): string[] =>
  [...source.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);

describe('kernel-worker realm boundary: esptool', () => {
  it('the worker build stubs esptool-operations, and only the worker build', () => {
    const config = read('vite.config.ts');
    expect(config).toContain('kernel\\/esptool-operations\\.js');
    const workerBlock = config.slice(config.indexOf('worker: {'));
    expect(workerBlock).toContain('stubPageRealmEsptoolPlugin()');
    expect(config.slice(0, config.indexOf('worker: {'))).not.toContain(
      'stubPageRealmEsptoolPlugin(),'
    );
  });

  it('the local backend is still gated on a DOM realm', () => {
    const backends = read('src/shell/supplemental-commands/esptool-backends.ts');
    expect(backends).toContain("import('../../kernel/esptool-operations.js')");
    expect(backends).toMatch(/if \(hasLocalDom && getNavigatorSerial\(\)\)/);
  });

  it('the stub exports every runtime export the real module exposes', () => {
    const real = runtimeExports(read('src/kernel/esptool-operations.ts'));
    expect(real.length).toBeGreaterThan(0);
    expect(runtimeExports(read('src/stubs/esptool-page-realm-stub.ts')).sort()).toEqual(
      real.sort()
    );
  });

  it('every stub export throws a page-realm-only error', () => {
    const entries = Object.entries(stub);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, fn] of entries) {
      expect(() => (fn as () => never)()).toThrow(`esptool.${name} is page-realm only`);
    }
  });
});
