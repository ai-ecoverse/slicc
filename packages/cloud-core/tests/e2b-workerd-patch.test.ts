import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the e2b / Cloudflare workerd incompatibility.
//
// e2b 2.33.0–2.35.1 emitted a top-level `var __require = (() => createRequire(
// import.meta.url))()` ESM-interop shim in dist/index.mjs (from its bundler,
// Rolldown). It runs at module-eval time; under workerd `import.meta.url` is
// undefined, so createRequire throws on import and crashes the tray-hub worker
// (which bundles e2b via @slicc/cloud-core). e2b 2.35.2 fixed this upstream —
// its build no longer emits the shim — so we dropped the patch-package patch we
// used to carry. This test stays as a defensive guard: it fails if the eager
// shim ever reappears in the installed dist (an upstream regression), which
// would crash the worker under workerd again.
//
// See docs/pitfalls.md ("e2b SDK in the Worker: createRequire Breaks workerd").
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
