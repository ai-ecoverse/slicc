import { describe, expect, it } from 'vitest';
import {
  type LiveMountFsApi,
  type LiveVfsPlugin,
  mountLiveVfsDirs,
} from '../../../src/kernel/realm/live-vfs-fs.js';
import type { SyncFsPosixBridge } from '../../../src/kernel/realm/sync-fs-xhr-bridge.js';

// Emscripten's FS.ErrnoError is no Error in newer runtimes; the warning used to
// read "live VFS mount of /tmp failed: [object Object]".
describe('mountLiveVfsDirs warnings', () => {
  it('names the errno of an ErrnoError-shaped failure', () => {
    const warnings: string[] = [];
    const Fs = {
      filesystems: { SLICC_LIVE_FS: {} as LiveVfsPlugin },
      mkdirTree: () => {},
      mount: () => {
        throw { name: 'ErrnoError', errno: 10 };
      },
    } as unknown as LiveMountFsApi;
    const { mounted } = mountLiveVfsDirs(Fs, {} as SyncFsPosixBridge, ['/tmp'], (m) =>
      warnings.push(m)
    );
    expect(mounted).toEqual([]);
    expect(warnings).toEqual(['live VFS mount of /tmp failed: errno 10']);
  });
});
