/**
 * Pin the Pyodide runtime-CDN URL to the installed package version.
 * The `PYODIDE_RUNTIME_CDN` constant is the single documented
 * runtime-CDN exception (Wave 8); the loader resolves from the
 * ipk-installed npm package via `realm-factory.ts`. If the pinned
 * version drifts from `node_modules/pyodide/package.json`, the
 * loader and the CDN-hosted wheel ecosystem disagree.
 */

import { version as pyodidePackageVersion } from 'pyodide/package.json';
import { describe, expect, it } from 'vitest';
import rootPackageJson from '../../../../../package.json';
import { PYODIDE_RUNTIME_CDN, PYODIDE_VERSION } from '../../../src/kernel/realm/py-realm-shared.js';

describe('Pyodide version resolution', () => {
  it('uses the installed pyodide package version for the runtime-CDN exception', () => {
    expect(PYODIDE_VERSION).toBe(pyodidePackageVersion);
    expect(PYODIDE_RUNTIME_CDN).toBe(
      `https://cdn.jsdelivr.net/pyodide/v${pyodidePackageVersion}/full/`
    );
  });

  it('keeps the root pyodide dependency pinned to the installed package version', () => {
    const pyodideVersion = rootPackageJson.dependencies.pyodide;
    expect(pyodideVersion).toBe(pyodidePackageVersion);
  });
});
