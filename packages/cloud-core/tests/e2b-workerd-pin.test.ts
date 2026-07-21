import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the e2b 2.33.0 / Cloudflare workerd incompatibility.
//
// e2b >=2.33.0 emits a top-level `createRequire(import.meta.url)` esbuild
// ESM-interop shim in dist/index.mjs. That runs at module-eval time and throws
// under workerd (`import.meta.url` is undefined there), crashing the tray-hub
// worker at startup — the worker bundles e2b via @slicc/cloud-core. e2b is
// therefore capped `>=2.23.0 <2.33.0` in the root, cloud-core, and node-server
// package.json, plus an allowedVersions rule in renovate.json.
//
// If this test fails, either a cap was removed/raised or e2b resolved to
// >=2.33.0. Do NOT lift the cap until e2b makes the shim lazy (init on first
// use) or ships an edge/browser export — see docs/pitfalls.md
// ("e2b SDK in the Worker: createRequire Breaks workerd").
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function resolvedE2bVersion(): string {
  const raw = readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8');
  const lock = JSON.parse(raw) as {
    packages: Record<string, { version?: string }>;
  };
  const version = lock.packages['node_modules/e2b']?.version;
  if (!version) throw new Error('e2b entry not found in package-lock.json');
  return version;
}

function isBelow2_33(version: string): boolean {
  const [major, minor] = version.split('.').map((n) => Number.parseInt(n, 10));
  return major < 2 || (major === 2 && minor < 33);
}

describe('e2b workerd pin', () => {
  it('resolves e2b below 2.33.0 (workerd createRequire incompatibility)', () => {
    const version = resolvedE2bVersion();
    expect(
      isBelow2_33(version),
      `e2b resolved to ${version}; it must stay <2.33.0 until the workerd ` +
        `createRequire shim is fixed (see docs/pitfalls.md).`
    ).toBe(true);
  });
});
