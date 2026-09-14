import type { LocalVfsClient } from '../kernel/local-vfs-client.js';

export interface GitPreviewBase {
  baseContent: string;

  status: 'modified';

  repoRoot: string;
}

const MAX_ASCENT = 24;

export async function findRepoRoot(fs: LocalVfsClient, path: string): Promise<string | null> {
  let dir = path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '/';

  for (let hops = 0; hops < MAX_ASCENT; hops += 1) {
    try {
      await fs.stat(dir === '/' ? '/.git' : `${dir}/.git`);
      return dir === '' ? '/' : dir;
    } catch {}
    if (dir === '/' || dir === '') return null;
    dir = dir.slice(0, Math.max(dir.lastIndexOf('/'), 0)) || '/';
  }
  return null;
}

interface GitStats {
  type: 'dir' | 'file';
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface ReadOnlyGitFs {
  promises: {
    readFile(path: string, options?: { encoding?: string } | string): Promise<string | Uint8Array>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<GitStats>;
    lstat(path: string): Promise<GitStats>;
    readlink(path: string): Promise<string>;
  };
}

function readOnlyGitFs(fs: LocalVfsClient): ReadOnlyGitFs {
  const stat = async (path: string): Promise<GitStats> => {
    const stats = await fs.stat(path);
    const isDir = stats.type === 'directory';
    return {
      type: isDir ? 'dir' : 'file',
      mode: isDir ? 0o040_755 : 0o100_644,
      size: stats.size,
      ino: 0,
      mtimeMs: stats.mtime,
      ctimeMs: stats.ctime,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => stats.isSymlink === true,
    };
  };

  return {
    promises: {
      readFile: (path: string, options?: { encoding?: string } | string) => {
        const encoding = typeof options === 'string' ? options : options?.encoding;
        return fs.readFile(
          path,
          encoding === 'utf8' ? { encoding: 'utf-8' } : { encoding: 'binary' }
        );
      },
      readdir: async (path: string) => (await fs.readDir(path)).map((entry) => entry.name),
      stat,
      lstat: stat,
      readlink: async (path: string) => (await fs.stat(path)).symlinkTarget ?? '',
    },
  };
}

export async function readGitBase(
  fs: LocalVfsClient,
  path: string,
  current: string
): Promise<GitPreviewBase | null> {
  const repoRoot = await findRepoRoot(fs, path);
  if (!repoRoot) return null;

  const relative = path.slice(repoRoot === '/' ? 1 : repoRoot.length + 1);
  if (relative.length === 0) return null;

  try {
    const git = await import('isomorphic-git');
    const gitFs = readOnlyGitFs(fs) as never;

    const oid = await git.resolveRef({ fs: gitFs, dir: repoRoot, ref: 'HEAD' });
    const { blob } = await git.readBlob({ fs: gitFs, dir: repoRoot, oid, filepath: relative });
    const baseContent = new TextDecoder().decode(blob);

    if (baseContent === current) return null;

    return { baseContent, status: 'modified', repoRoot };
  } catch {
    return null;
  }
}
