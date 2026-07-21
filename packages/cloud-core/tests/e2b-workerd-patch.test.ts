import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the e2b / Cloudflare workerd incompatibility.
//
// e2b >=2.33.0 emits a top-level `var __require = (() => createRequire(
// import.meta.url))()` ESM-interop shim in dist/index.mjs (from its bundler,
// Rolldown). It runs at module-eval time; under workerd `import.meta.url` is
// undefined, so createRequire throws on import and crashes the tray-hub worker
// (which bundles e2b via @slicc/cloud-core). We carry patches/e2b+<ver>.patch
// (patch-package) that makes __require lazy so a bare import no longer evaluates
// createRequire. This test fails if that patch is missing or stops applying —
// i.e. the eager shim reappears in the installed dist.
//
// See docs/pitfalls.md ("e2b SDK in the Worker: createRequire Breaks workerd").
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EAGER_SHIM = '(() => createRequire(import.meta.url))()';

describe('e2b workerd patch', () => {
  it('neutralizes the eager createRequire(import.meta.url) shim in the installed e2b', () => {
    const distPath = resolve(repoRoot, 'node_modules/e2b/dist/index.mjs');
    const src = readFileSync(distPath, 'utf8');
    expect(
      src.includes(EAGER_SHIM),
      `Installed e2b still contains the eager createRequire shim (${EAGER_SHIM}); ` +
        `the patches/e2b+*.patch is missing or failed to apply, which crashes the ` +
        `tray-hub worker under workerd. Reconcile the patch — see docs/pitfalls.md.`
    ).toBe(false);
  });
});
