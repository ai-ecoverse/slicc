import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { installPackage } from '../../../src/shell/ipk/installer.js';
import { fetchPackument, resolveVersion } from '../../../src/shell/ipk/registry.js';
import { LIVE_REGISTRY, nodeFetch } from './helpers/live-registry.js';

let dbCounter = 0;

describe.skipIf(!LIVE_REGISTRY)('ipk against the live npm registry', () => {
  it('verifies every tarball of a real tree and installs it', async () => {
    const fs = await VirtualFS.create({ dbName: `ipk-live-${dbCounter++}`, wipe: true });
    const result = await installPackage('chalk@^4', { fs, fetch: nodeFetch, cwd: '/work' });
    expect(result.version).toMatch(/^4\./);
    for (const dep of ['chalk', 'ansi-styles', 'supports-color', 'has-flag', 'color-convert']) {
      await expect(fs.exists(`/work/node_modules/${dep}/package.json`)).resolves.toBe(true);
    }
    await fs.dispose();
  }, 60_000);

  it('picks the live latest of every @ai-ecoverse/wasm-* package for "*", as pnpm does', async () => {
    for (const name of [
      '@ai-ecoverse/wasm-zlib',
      '@ai-ecoverse/wasm-bash',
      '@ai-ecoverse/wasm-sed',
    ]) {
      const pk = await fetchPackument(name, nodeFetch);
      const latest = pk['dist-tags']?.latest;
      expect(latest, name).toBeTruthy();
      if (!pk.versions[latest as string].deprecated) {
        expect(resolveVersion(pk, '*'), name).toBe(latest);
      }
    }
    const zlib = await fetchPackument('@ai-ecoverse/wasm-zlib', nodeFetch);
    expect(resolveVersion(zlib, '^1.3.1-1')).not.toBe('1.3.1');
  }, 60_000);
});
