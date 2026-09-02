import * as fs from 'node:fs';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe('isomorphic-git pack checksum patch (#2735)', () => {
  it('shares one SHA-1 verification across concurrent readers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slicc-pack-verification-'));
    temporaryDirectories.push(dir);
    await git.init({ fs, dir });

    const blob = new TextEncoder().encode('shared packed object\n');
    const oid = await git.writeBlob({ fs, dir, blob });
    const { filename } = await git.packObjects({ fs, dir, oids: [oid], write: true });
    await git.indexPack({ fs, dir, filepath: `.git/objects/pack/${filename}` });
    await unlink(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));

    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    const cache = {};
    const reads = await Promise.all(
      Array.from({ length: 12 }, () => git.readObject({ fs, dir, oid, cache }))
    );

    expect(
      reads.every(
        (result) =>
          result.format === 'content' &&
          new TextDecoder().decode(result.object) === 'shared packed object\n'
      )
    ).toBe(true);
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it.each(['index.js', 'index.cjs', 'managers/index.js', 'managers/index.cjs'])(
    '%s memoizes the in-flight verification promise',
    async (relativePath) => {
      const source = await readFile(
        resolve(repoRoot, 'node_modules/isomorphic-git', relativePath),
        'utf8'
      );
      expect(source).toContain('p._checksumVerification = (async () => {');
      expect(source).toContain('await p._checksumVerification;');
      expect(source).not.toContain('if (!p._checksumVerified)');
    }
  );
});
