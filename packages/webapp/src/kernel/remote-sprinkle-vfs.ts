import type { BoundedWalkOptions } from '../fs/bounded-walk.js';
import { walkBounded } from '../fs/bounded-walk.js';
import type { VirtualFS } from '../fs/index.js';
import type { ReadFileOptions } from '../fs/types.js';
import { FsError } from '../fs/types.js';
import type { LocalVfsClient } from './local-vfs-client.js';
import type { WritableVfsBackend } from './writable-vfs-client.js';

export interface RemoteSprinkleVfsOptions {
  reader: LocalVfsClient;

  writer: WritableVfsBackend;
}

async function pathExists(reader: LocalVfsClient, path: string): Promise<boolean> {
  try {
    await reader.stat(path);
    return true;
  } catch (err) {
    if (err instanceof FsError && err.code === 'ENOENT') return false;
    return false;
  }
}

export function createRemoteSprinkleVfs(opts: RemoteSprinkleVfsOptions): VirtualFS {
  const { reader, writer } = opts;

  const adapter = {
    readFile: (path: string, options?: ReadFileOptions) => reader.readFile(path, options),
    readDir: (path: string) => reader.readDir(path),
    stat: (path: string) => reader.stat(path),
    writeFile: (
      path: string,
      content: Parameters<WritableVfsBackend['writeFile']>[1],
      options?: Parameters<WritableVfsBackend['writeFile']>[2]
    ) => writer.writeFile(path, content, options),
    mkdir: (path: string, options?: Parameters<WritableVfsBackend['mkdir']>[1]) =>
      writer.mkdir(path, options),
    rm: (path: string, options?: Parameters<WritableVfsBackend['rm']>[1]) =>
      writer.rm(path, options),
    flush: () => writer.flush(),
    exists: (path: string) => pathExists(reader, path),
    walk: (path: string, options?: BoundedWalkOptions) => walkBounded(reader, path, options),
  };

  return adapter as unknown as VirtualFS;
}
