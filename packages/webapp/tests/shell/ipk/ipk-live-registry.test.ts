/**
 * Live checks against the real npm registry. Skipped unless
 * `IPK_LIVE_REGISTRY=1`; never run in CI.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { installPackage } from '../../../src/shell/ipk/installer.js';
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
});
