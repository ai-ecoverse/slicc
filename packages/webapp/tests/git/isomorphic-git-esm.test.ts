/**
 * Guards against isomorphic-git CJS/ESM resolution regression.
 *
 * isomorphic-git >=1.37.5 added `require('crypto').createHash('sha1')` to
 * the CJS bundle (index.cjs) via a new `shasumRange` function. The ESM
 * bundle (index.js) uses sha.js instead — browser-safe. The package's
 * exports map only has a "default" condition (no "import"), so bundlers
 * resolve to the broken CJS entry unless overridden via resolve.alias
 * in vite.config.ts, the extension vite.config.ts, and vitest.config.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const isoGitDir = resolve(__dirname, '../../../../node_modules/isomorphic-git');

describe('isomorphic-git browser compatibility', () => {
  it('ESM entry does not depend on Node crypto', () => {
    const esm = readFileSync(resolve(isoGitDir, 'index.js'), 'utf-8');
    expect(esm).not.toContain("require('crypto')");
    expect(esm).not.toContain('require("crypto")');
  });

  it('CJS entry has the Node crypto dependency (documents the upstream bug)', () => {
    const cjs = readFileSync(resolve(isoGitDir, 'index.cjs'), 'utf-8');
    // If this assertion fails, the upstream bug may be fixed and the
    // resolve.alias workaround in vite configs can be removed.
    expect(cjs).toContain("require('crypto')");
  });

  it('hashBlob produces a valid SHA-1 via the browser-safe path', async () => {
    const git = await import('isomorphic-git');
    const result = await git.hashBlob({
      object: new Uint8Array([72, 101, 108, 108, 111]),
    });
    expect(result.oid).toHaveLength(40);
    expect(result.oid).toMatch(/^[0-9a-f]{40}$/);
  });
});
