import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EAGER_SHIM = '(() => createRequire(import.meta.url))()';

describe('e2b workerd compatibility', () => {
  it('installed e2b has no eager createRequire(import.meta.url) module-eval shim', () => {
    const distPath = resolve(repoRoot, 'node_modules/e2b/dist/index.mjs');
    const src = readFileSync(distPath, 'utf8');
    expect(
      src.includes(EAGER_SHIM),
      `Installed e2b again contains the eager createRequire shim (${EAGER_SHIM}); ` +
        `e2b regressed the upstream fix (2.35.2), which crashes the tray-hub worker ` +
        `under workerd. Pin e2b or re-add patches/e2b+<ver>.patch — see docs/pitfalls.md.`
    ).toBe(false);
  });
});
