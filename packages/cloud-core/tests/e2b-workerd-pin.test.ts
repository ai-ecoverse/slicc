import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the e2b 2.33.0 / Cloudflare workerd incompatibility.
//
// e2b >=2.33.0 emits a top-level `createRequire(import.meta.url)` ESM-interop
// shim in dist/index.mjs (from its bundler, Rolldown). That runs at module-eval
// time and throws under workerd (`import.meta.url` is undefined there), crashing
// the tray-hub worker at startup — the worker bundles e2b via @slicc/cloud-core.
// e2b is therefore capped `>=2.23.0 <2.33.0` in the root, cloud-core, and
// node-server package.json, plus an allowedVersions rule in renovate.json.
//
// If this test fails, either a cap was removed/raised or e2b resolved to
// >=2.33.0. Do NOT lift the cap until e2b makes the shim lazy (init on first
// use) or ships an edge/browser export — see docs/pitfalls.md
// ("e2b SDK in the Worker: createRequire Breaks workerd").
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Every e2b install in the tree: the hoisted copy plus any nested
// packages/*/node_modules/e2b a future uncapped consumer could force in.
function resolvedE2bVersions(): string[] {
  const raw = readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8');
  const lock = JSON.parse(raw) as {
    packages: Record<string, { version?: string }>;
  };
  const versions = Object.entries(lock.packages)
    .filter(([key]) => key === 'node_modules/e2b' || key.endsWith('/node_modules/e2b'))
    .map(([, entry]) => entry.version)
    .filter((v): v is string => typeof v === 'string');
  if (versions.length === 0) {
    throw new Error('no e2b entry found in package-lock.json');
  }
  return versions;
}

function isBelow2_33(version: string): boolean {
  const [major, minor] = version.split('.').map((n) => Number.parseInt(n, 10));
  return major < 2 || (major === 2 && minor < 33);
}

describe('e2b workerd pin', () => {
  it('resolves every e2b install below 2.33.0 (workerd createRequire incompatibility)', () => {
    for (const version of resolvedE2bVersions()) {
      expect(
        isBelow2_33(version),
        `e2b resolved to ${version}; every install must stay <2.33.0 until the ` +
          `workerd createRequire shim is fixed (see docs/pitfalls.md).`
      ).toBe(true);
    }
  });
});
