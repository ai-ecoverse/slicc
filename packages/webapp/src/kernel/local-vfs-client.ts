/**
 * `LocalVfsClient` — read-only facade over the page's local VFS.
 *
 * The page-side panels (file-browser, memory) read from the same
 * IndexedDB the kernel worker uses, but **can't write** — writes
 * would diverge from the worker's view of the VFS. The worker
 * remains the canonical writer; future panel-initiated writes route
 * through `kernelClient.fs.*` RPCs.
 *
 * Today the panels only read (`readDir`, `readFile`, `stat`), so the
 * facade is purely a type-system constraint. It's a structural
 * subset of `VirtualFS`, so `VirtualFS` instances satisfy it for
 * free — extension panel and inline standalone paths keep working
 * without changes. The benefit is at the panel signatures: typing
 * panel inputs as `LocalVfsClient` makes a future
 * `panel.someWrite(...)` call fail at compile time.
 */

import type { DirEntry, ReadFileOptions, Stats } from '../fs/types.js';

export interface LocalVfsClient {
  /**
   * List entries in `path`. Same semantics as `VirtualFS.readDir`.
   */
  readDir(path: string): Promise<DirEntry[]>;

  /**
   * Read a file. Same semantics as `VirtualFS.readFile` — the
   * `options.encoding` discriminates the return shape (`string` for
   * `'utf-8'`, `Uint8Array` for `'binary'`).
   */
  readFile(path: string, options?: ReadFileOptions): Promise<string | Uint8Array>;

  /**
   * Stat a path. Throws `FsError(ENOENT)` if missing.
   */
  stat(path: string): Promise<Stats>;
}

/**
 * Wrap a `VirtualFS` (or anything with the matching read methods) as
 * a `LocalVfsClient`. The wrapper is a thin pass-through; its job is
 * to enforce read-only access by hiding the rest of the VFS surface.
 *
 * Use this in panel-side wiring (e.g. `mainStandaloneWorker`) when
 * you want the type system to catch accidental writes.
 */
export function createLocalVfsClient(source: LocalVfsClient): LocalVfsClient {
  return {
    readDir: (path) => source.readDir(path),
    readFile: (path, options) => source.readFile(path, options),
    stat: (path) => source.stat(path),
  };
}
