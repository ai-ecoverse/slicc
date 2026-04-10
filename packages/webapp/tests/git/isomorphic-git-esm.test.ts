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
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const isoGitDir = resolve(currentDir, '../../../../node_modules/isomorphic-git');
const nodeCryptoRequirePattern = /require\s*\(\s*['"](?:node:)?crypto['"]\s*\)/;

describe('isomorphic-git browser compatibility', () => {
  it('ESM entry does not depend on Node crypto', () => {
    const esm = readFileSync(resolve(isoGitDir, 'index.js'), 'utf-8');
    expect(esm).not.toMatch(nodeCryptoRequirePattern);
  });

  it('CJS entry has the Node crypto dependency (documents the upstream bug)', () => {
    const cjs = readFileSync(resolve(isoGitDir, 'index.cjs'), 'utf-8');
    // If this assertion fails, the upstream bug may be fixed and the
    // resolve.alias workaround in vite configs can be removed.
    expect(cjs).toMatch(nodeCryptoRequirePattern);
  });

  it('hashBlob produces the expected SHA-1 via the browser-safe path', async () => {
    const git = await import('isomorphic-git');
    const result = await git.hashBlob({
      object: new Uint8Array([72, 101, 108, 108, 111]),
    });
    expect(result.oid).toBe('5ab2f8a4323abafb10abb68657d9d39f1a775057');
  });
});
