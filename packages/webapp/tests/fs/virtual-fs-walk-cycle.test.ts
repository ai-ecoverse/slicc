import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { VirtualFS } from '../../src/fs/index.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { createCyclicDirectoryHandle } from './fsa-test-helpers.js';

describe('VirtualFS.walk cycle safety', () => {
  it('terminates on a self-referential mount instead of looping forever', async () => {
    globalThis.indexedDB = new IDBFactory();
    const vfs = await VirtualFS.create({ wipe: true });
    await vfs.mount(
      '/mnt/cyclic',
      LocalMountBackend.fromHandle(createCyclicDirectoryHandle(), { mountId: 'walk-cycle-test' })
    );

    // `realpath()` returns mount paths unchanged ("already real"), so walk()'s
    // visited-set cannot collapse the /mnt/cyclic/loop/loop/… cycle — only the
    // depth/entry bound stops it. Without the bound this loops forever (the
    // consumer would run until SAFETY, or the test would time out).
    const SAFETY = 5000;
    let count = 0;
    for await (const _file of vfs.walk('/mnt/cyclic')) {
      if (++count >= SAFETY) break;
    }

    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(SAFETY);
  }, 15000);
});
