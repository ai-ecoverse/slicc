/**
 * Pin the Pyodide CDN URL to the installed package version. The
 * realm worker (`py-realm-worker.ts`) loads Pyodide at the URL
 * resolved here; if the pinned version drifts from
 * `node_modules/pyodide/package.json`, the loader and the CDN
 * assets disagree and Pyodide fails at runtime.
 */

import { describe, it, expect } from 'vitest';
import { version as pyodidePackageVersion } from 'pyodide/package.json';
import rootPackageJson from '../../../../../package.json';
import { PYODIDE_CDN, PYODIDE_VERSION } from '../../../src/kernel/realm/py-realm-shared.js';

describe('Pyodide version resolution', () => {
  it('uses the installed pyodide package version for the browser CDN fallback', () => {
    expect(PYODIDE_VERSION).toBe(pyodidePackageVersion);
    expect(PYODIDE_CDN).toBe(`https://cdn.jsdelivr.net/pyodide/v${pyodidePackageVersion}/full/`);
  });

  it('keeps the root pyodide dependency pinned to the installed package version', () => {
    const pyodideVersion = rootPackageJson.dependencies.pyodide;
    expect(pyodideVersion).toBe(pyodidePackageVersion);
  });
});
