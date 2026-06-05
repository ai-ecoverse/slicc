/**
 * `createRemoteSprinkleVfs` — wrap the worker-RPC-backed VFS clients
 * in the `VirtualFS`-shaped surface that `SprinkleManager`,
 * `SprinkleBridge`, and `discoverSprinkles` actually call.
 *
 * Under `slicc_opfs_vfs === 'opfs'` the page-side `localFs` is forced
 * to an empty `memory` backend (see `main.ts` — the worker is the
 * canonical OPFS owner). Passing that `localFs` straight to
 * `SprinkleManager` strands sprinkle discovery: `fs.walk('/')` over
 * an empty in-process VFS yields nothing, so `sprinkle list` returns
 * zero even when `.shtml` files live under `/shared/sprinkles` in
 * OPFS. This adapter routes reads through `panelReadVfs` (the
 * `RemoteVfsClient`) and writes through `writableFs` (the
 * `RemoteWritableVfsClient` on the OPFS leader, or the page-side
 * shadow for followers), and polyfills the two methods missing from
 * the wire surface — `walk` (recursive `readDir`+`stat`) and `exists`
 * (`stat` with ENOENT swallow) — so callers see the same `VirtualFS`
 * shape they would without the flag.
 *
 * Symlink semantics mirror `VirtualFS.walk`: a symlink to a file is
 * yielded; a symlink to a directory is recursed; broken symlinks are
 * skipped. OPFS itself doesn't model symlinks, but mounted backends
 * exposed over the wire may, and the host's `vfs-stat-result`
 * follows them by default.
 */

import type { VirtualFS } from '../fs/index.js';
import type { DirEntry, ReadFileOptions } from '../fs/types.js';
import { FsError } from '../fs/types.js';
import type { LocalVfsClient } from './local-vfs-client.js';
import type { WritableVfsBackend } from './writable-vfs-client.js';

export interface RemoteSprinkleVfsOptions {
  /**
   * Read-side client. In OPFS mode both leader and follower set this
   * to the worker-backed `RemoteVfsClient` so discovery sees the
   * canonical tree.
   */
  reader: LocalVfsClient;
  /**
   * Write-side backend. On the OPFS leader this is a
   * `RemoteWritableVfsClient`; on followers (and with the flag off)
   * callers can pass any local `WritableVfsBackend` — sprinkle
   * `writeFile`/`mkdir`/`rm` then land wherever that backend points.
   */
  writer: WritableVfsBackend;
}

function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
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
    exists: async (path: string): Promise<boolean> => {
      try {
        await reader.stat(path);
        return true;
      } catch (err) {
        if (err instanceof FsError && err.code === 'ENOENT') return false;
        return false;
      }
    },
    walk: async function* (path: string): AsyncGenerator<string> {
      const stack: string[] = [path];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const dir = stack.pop() as string;
        if (visited.has(dir)) continue;
        visited.add(dir);
        let entries: DirEntry[];
        try {
          entries = await reader.readDir(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          const child = joinPath(dir, entry.name);
          if (entry.type === 'file') {
            yield child;
          } else if (entry.type === 'directory') {
            stack.push(child);
          } else if (entry.type === 'symlink') {
            try {
              const s = await reader.stat(child);
              if (s.type === 'file') yield child;
              else if (s.type === 'directory') stack.push(child);
            } catch {
              /* dangling symlink — skip, matches VirtualFS.walk */
            }
          }
        }
      }
    },
  };

  return adapter as unknown as VirtualFS;
}
