/**
 * Guards against isomorphic-git CJS/ESM resolution regression.
 *
 * The pinned dependency resolves "." to index.cjs via its exports map, and
 * that CJS entry imports Node's `crypto` module. The ESM bundle (index.js)
 * uses sha.js instead, so the browser builds and Vitest alias
 * `isomorphic-git` to the ESM entry on purpose.
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

  it('CJS entry still imports Node crypto, which is why we alias to ESM', () => {
    const cjs = readFileSync(resolve(isoGitDir, 'index.cjs'), 'utf-8');
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
