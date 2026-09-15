import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createMutableDirectoryHandle } from './fsa-test-helpers.js';

const instances: VirtualFS[] = [];
let sequence = 0;
beforeEach(() => {
  const root = createMutableDirectoryHandle({});
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root.handle } });
});
afterEach(async () => {
  for (const fs of instances.splice(0).reverse()) await fs.dispose();
  vi.unstubAllGlobals();
});
async function create(options: Parameters<typeof VirtualFS.create>[0]) {
  const fs = await VirtualFS.create(options);
  instances.push(fs);
  return fs;
}
async function close(fs: VirtualFS) {
  await fs.dispose();
  instances.splice(instances.indexOf(fs), 1);
}

describe('optional OPFS async cache', () => {
  it.each([true, false])(
    'preserves async read/write with cache=%s and inherits the live mode',
    async (opfsAsyncCache) => {
      const dbName = `async-cache-${sequence++}`;
      const fs = await create({ dbName, backend: 'opfs', wipe: true, opfsAsyncCache });
      await fs.writeFile('/file', 'hello');
      const peer = await create({ dbName, backend: 'opfs' });
      expect(await peer.readTextFile('/file')).toBe('hello');
      if (!opfsAsyncCache) expect(peer.statSync('/file')).toBe(null);
      await expect(
        VirtualFS.create({ dbName, backend: 'opfs', opfsAsyncCache: !opfsAsyncCache })
      ).rejects.toMatchObject({ code: 'EBUSY' });
      expect(await fs.readTextFile('/file')).toBe('hello');
    }
  );

  it('serializes concurrent initializers before accepting a cache configuration', async () => {
    const dbName = `async-cache-race-${sequence++}`;
    const first = create({ dbName, backend: 'opfs', opfsAsyncCache: false });
    const second = VirtualFS.create({ dbName, backend: 'opfs', opfsAsyncCache: true });
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'EBUSY' } });
    await (await first).writeFile('/still-live', 'yes');
    expect(await (await first).readTextFile('/still-live')).toBe('yes');
  });

  it.each([undefined, false, true])(
    'rejects a live wipe with cache=%s before touching storage or shared holders',
    async (opfsAsyncCache) => {
      const dbName = `async-cache-wipe-${sequence++}`;
      const fs = await create({ dbName, backend: 'opfs', opfsAsyncCache: false });
      await fs.writeFile('/file', 'keep');
      const peer = await create({ dbName, backend: 'opfs' });
      await expect(
        VirtualFS.create({ dbName, backend: 'opfs', wipe: true, opfsAsyncCache })
      ).rejects.toMatchObject({ code: 'EBUSY' });
      expect(await fs.readTextFile('/file')).toBe('keep');
      await peer.writeFile('/file', 'still shared');
      expect(await fs.readTextFile('/file')).toBe('still shared');
      await close(peer);
      await close(fs);
      const reloaded = await create({ dbName, backend: 'opfs' });
      expect(await reloaded.readTextFile('/file')).toBe('still shared');
      await close(reloaded);
      const wiped = await create({ dbName, backend: 'opfs', wipe: true, opfsAsyncCache });
      expect(await wiped.exists('/file')).toBe(false);
    }
  );

  it('does not disable the memory backend synchronous fast paths', async () => {
    const fs = await create({
      dbName: `async-cache-memory-${sequence++}`,
      backend: 'memory',
      opfsAsyncCache: false,
    });
    await fs.writeFile('/file', 'hello');
    expect(fs.statSync('/file')?.size).toBe(5);
  });
});
