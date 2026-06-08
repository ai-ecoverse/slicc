/**
 * `mount-bomb-fs.ts` — an Emscripten FS plugin whose `node_ops` and
 * `stream_ops` ALL throw a guiding `ErrnoError`. Mounted at each VFS
 * mount path overlapping the Python realm's sync dirs so any
 * synchronous access from Python (stdlib `open`, `os.listdir`,
 * `pathlib`, pandas, …) raises immediately with a message naming
 * the path and pointing the caller at the async `slicc.fs` module
 * (or to copy the file into the VFS first).
 *
 * Critically, the mount is INSTANT — no walk, no preload, no async
 * RPC traffic. This is what unblocks `python3` startup over a large
 * local mount (the 11k-files / 24k-RPCs hang that PR #919's eager
 * materialization caused).
 */

import { type EmscriptenFsApi, ERRNO, type FsNode } from './opfs-sync-fs.js';

/** Emscripten directory mode (S_IFDIR | 0o755). */
const DIR_MODE = 0o040000 | 0o755;

/**
 * Minimal mount shape Emscripten passes to `plugin.mount(mount)`.
 * Carries the user-supplied `opts.mountPath` so each throw can name
 * the path the kernel intended to overlay.
 */
export interface MountBombOpts {
  /** Absolute mount path (e.g. `/mnt/kb`). Used verbatim in the error message. */
  mountPath: string;
}

export interface MountBombMount {
  opts: MountBombOpts;
  mountpoint: string;
  root: FsNode;
}

/** The plugin object you assign to `pyodide.FS.filesystems.MOUNT_BOMB_FS`. */
export interface MountBombFsPlugin {
  mount(mount: MountBombMount): FsNode;
  createNode(parent: FsNode | null, name: string, mode: number, dev?: number): FsNode;
  // Every op throws. Emscripten doesn't expose a strict shape for
  // these — typed loosely so the per-op `never` returns slot in.
  node_ops: Record<string, (...args: never[]) => never>;
  stream_ops: Record<string, (...args: never[]) => never | void>;
}

/**
 * Build the actionable bomb message used by every thrown error.
 * Names the path verbatim and directs the caller at the two
 * documented escape hatches: `await slicc.fs.<op>(<path>)` for
 * on-demand reads/writes, or copying the file into the VFS first
 * (which then makes the file visible to stdlib).
 */
export function formatBombMessage(mountPath: string): string {
  return (
    `slicc: synchronous access to mounted path '${mountPath}' is not supported. ` +
    `Use the async slicc.fs module (e.g. \`await slicc.fs.read_text('${mountPath}')\` ` +
    `or \`await slicc.fs.listdir('${mountPath}')\`), or copy the file into the VFS first ` +
    `(\`await slicc.fs.read_bytes('${mountPath}/<file>')\` then write it under /tmp).`
  );
}

/**
 * Construct an `ErrnoError` enriched with the bomb message. The base
 * `ErrnoError` constructor only takes an errno, so we patch the
 * `.message` after construction; Pyodide's Python-side translation
 * surfaces it as the `OSError.strerror`.
 */
function bomb(Fs: EmscriptenFsApi, mountPath: string): Error {
  const err = new Fs.ErrnoError(ERRNO.EIO);
  err.message = formatBombMessage(mountPath);
  return err;
}

/**
 * Construct the `MOUNT_BOMB_FS` plugin. Symmetric to `createOpfsSyncFs`
 * — the kernel registers the plugin once on `pyodide.FS.filesystems`
 * and then `FS.mount(plugin, { mountPath }, mountPath)` per overlay.
 *
 * `mount(mount)` returns a single root `FsNode` so Emscripten's mount
 * table has something to attach. The root is a directory so the path
 * itself appears to exist (so the bomb fires on access to a child or
 * a stat of the root, not on the mount call), but every operation —
 * `lookup`, `readdir`, `getattr`, `mknod`, `unlink`, `rmdir`,
 * `rename`, `symlink`, `readlink`, `setattr`, stream open/read/write
 * — throws the bomb error.
 */
export function createMountBombFs(Fs: EmscriptenFsApi): MountBombFsPlugin {
  const plugin: MountBombFsPlugin = {
    mount(mount: MountBombMount): FsNode {
      const root = Fs.createNode(null, '/', DIR_MODE, 0) as FsNode;
      root.node_ops = plugin.node_ops as unknown as FsNode['node_ops'];
      root.stream_ops = plugin.stream_ops as unknown as FsNode['stream_ops'];
      root.mount = mount as unknown as FsNode['mount'];
      return root;
    },
    createNode(parent: FsNode | null, name: string, mode: number, dev = 0): FsNode {
      const node = Fs.createNode(parent, name, mode, dev) as FsNode;
      node.node_ops = plugin.node_ops as unknown as FsNode['node_ops'];
      node.stream_ops = plugin.stream_ops as unknown as FsNode['stream_ops'];
      if (parent !== null) node.mount = parent.mount;
      return node;
    },
    // Every node_op throws. `getattr` of the root is the one common
    // call Python makes that we'd otherwise want to succeed (so `stat`
    // of the mount path returns "directory"), but answering it would
    // mask the bomb intent — a script that checks `os.path.isdir`
    // before iterating must also be redirected to slicc.fs.
    node_ops: {
      getattr: (node: FsNode): never => {
        throw bomb(getFs(node), getMountPath(node));
      },
      setattr: (node: FsNode): never => {
        throw bomb(getFs(node), getMountPath(node));
      },
      lookup: (parent: FsNode): never => {
        throw bomb(getFs(parent), getMountPath(parent));
      },
      mknod: (parent: FsNode): never => {
        throw bomb(getFs(parent), getMountPath(parent));
      },
      rename: (oldNode: FsNode): never => {
        throw bomb(getFs(oldNode), getMountPath(oldNode));
      },
      unlink: (parent: FsNode): never => {
        throw bomb(getFs(parent), getMountPath(parent));
      },
      rmdir: (parent: FsNode): never => {
        throw bomb(getFs(parent), getMountPath(parent));
      },
      readdir: (node: FsNode): never => {
        throw bomb(getFs(node), getMountPath(node));
      },
      symlink: (parent: FsNode): never => {
        throw bomb(getFs(parent), getMountPath(parent));
      },
      readlink: (node: FsNode): never => {
        throw bomb(getFs(node), getMountPath(node));
      },
    },
    stream_ops: {
      open: (stream: { node: FsNode }): never => {
        throw bomb(getFs(stream.node), getMountPath(stream.node));
      },
      close: (): void => {
        /* defensive — never reached because open() throws */
      },
      read: (stream: { node: FsNode }): never => {
        throw bomb(getFs(stream.node), getMountPath(stream.node));
      },
      write: (stream: { node: FsNode }): never => {
        throw bomb(getFs(stream.node), getMountPath(stream.node));
      },
      llseek: (stream: { node: FsNode }): never => {
        throw bomb(getFs(stream.node), getMountPath(stream.node));
      },
    },
  };

  // FsApi reference is closed over via a per-node lookup so the plugin
  // factory itself doesn't need to plumb `Fs` into each closure.
  function getFs(_node: FsNode): EmscriptenFsApi {
    return Fs;
  }

  return plugin;
}

function getMountPath(node: FsNode): string {
  const mount = node.mount as unknown as { opts?: { mountPath?: string }; mountpoint?: string };
  return mount?.opts?.mountPath ?? mount?.mountpoint ?? '<unknown mount>';
}

/**
 * Lazily register the `MOUNT_BOMB_FS` plugin on `pyodide.FS.filesystems`.
 * Idempotent — re-mount calls share the single plugin reference so
 * Emscripten's mount table keys (which use plugin identity) stay
 * stable. Mirrors `ensureOpfsSyncFsRegistered` in `py-realm-shared.ts`.
 */
export function ensureMountBombFsRegistered(
  filesystems: Record<string, unknown>,
  Fs: EmscriptenFsApi
): MountBombFsPlugin {
  let plugin = filesystems.MOUNT_BOMB_FS as MountBombFsPlugin | undefined;
  if (!plugin) {
    plugin = createMountBombFs(Fs);
    filesystems.MOUNT_BOMB_FS = plugin;
  }
  return plugin;
}

/**
 * Mount `MOUNT_BOMB_FS` over every {@link mountPaths} entry so any
 * synchronous read from Python under those paths raises the bomb
 * error immediately — no walk, no preload, no hang. Each mount is
 * O(1): we ensure the path exists in the Pyodide FS (`mkdirTree`)
 * and `FS.mount(plugin, { mountPath }, path)`.
 *
 * Per-path failures (existing non-directory, mount collision, …)
 * surface through {@link pushWarning} and the loop continues with
 * the next path. The realm still runs — Python just sees the OPFS
 * placeholder under that path instead of the bomb.
 */
export function installMountBombs(
  pyodideFs: {
    stat: (path: string) => unknown;
    mkdirTree: (path: string) => void;
    mount: (plugin: unknown, opts: unknown, dir: string) => unknown;
    filesystems: Record<string, unknown>;
    createNode(parent: FsNode | null, name: string, mode: number, dev?: number): FsNode;
    isDir(mode: number): boolean;
    isFile(mode: number): boolean;
    isLink(mode: number): boolean;
    ErrnoError: new (errno: number) => Error & { errno: number };
  },
  mountPaths: readonly string[],
  pushWarning: (message: string) => void = () => {}
): void {
  if (mountPaths.length === 0) return;
  const plugin = ensureMountBombFsRegistered(pyodideFs.filesystems, pyodideFs);
  for (const path of mountPaths) {
    try {
      try {
        pyodideFs.stat(path);
      } catch {
        pyodideFs.mkdirTree(path);
      }
      pyodideFs.mount(plugin, { mountPath: path } satisfies MountBombOpts, path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushWarning(`mount '${path}': bomb overlay failed: ${message}`);
    }
  }
}
