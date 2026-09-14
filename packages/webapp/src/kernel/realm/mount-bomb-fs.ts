import { type EmscriptenFsApi, ERRNO, type FsNode } from './opfs-sync-fs.js';

const DIR_MODE = 0o040000 | 0o755;

export interface MountBombOpts {
  mountPath: string;
}

export interface MountBombMount {
  opts: MountBombOpts;
  mountpoint: string;
  root: FsNode;
}

export interface MountBombFsPlugin {
  mount(mount: MountBombMount): FsNode;
  createNode(parent: FsNode | null, name: string, mode: number, dev?: number): FsNode;

  node_ops: Record<string, (...args: never[]) => never>;
  stream_ops: Record<string, (...args: never[]) => never | void>;
}

export interface MountBombFilesystems {
  MOUNT_BOMB_FS?: MountBombFsPlugin;
}

export interface MountBombPyodideFs extends EmscriptenFsApi {
  stat: (path: string) => unknown;
  mkdirTree: (path: string) => void;
  mount: (plugin: MountBombFsPlugin, opts: MountBombOpts, dir: string) => unknown;
  filesystems: MountBombFilesystems;
}

export function formatBombMessage(mountPath: string): string {
  return (
    `slicc: synchronous access to mounted path '${mountPath}' is not supported. ` +
    `Use the async slicc.fs module (e.g. \`await slicc.fs.read_text('${mountPath}')\` ` +
    `or \`await slicc.fs.listdir('${mountPath}')\`), or copy the file into the VFS first ` +
    `(\`await slicc.fs.read_bytes('${mountPath}/<file>')\` then write it under /tmp).`
  );
}

function bomb(Fs: EmscriptenFsApi, mountPath: string): Error {
  const err = new Fs.ErrnoError(ERRNO.EIO);
  err.message = formatBombMessage(mountPath);
  return err;
}

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
      close: (): void => {},
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

  function getFs(_node: FsNode): EmscriptenFsApi {
    return Fs;
  }

  return plugin;
}

function getMountPath(node: FsNode): string {
  const mount = node.mount as unknown as { opts?: { mountPath?: string }; mountpoint?: string };
  return mount?.opts?.mountPath ?? mount?.mountpoint ?? '<unknown mount>';
}

export function ensureMountBombFsRegistered(
  filesystems: MountBombFilesystems,
  Fs: EmscriptenFsApi
): MountBombFsPlugin {
  let plugin = filesystems.MOUNT_BOMB_FS;
  if (!plugin) {
    plugin = createMountBombFs(Fs);
    filesystems.MOUNT_BOMB_FS = plugin;
  }
  return plugin;
}

export function installMountBombs(
  pyodideFs: MountBombPyodideFs,
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
