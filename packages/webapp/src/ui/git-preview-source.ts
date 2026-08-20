/**
 * The committed version of a file, for the preview's diff mode.
 *
 * When you open a file that has uncommitted changes, "what did I change?" is
 * usually the actual question — so the previewer wants the HEAD blob alongside
 * the working copy. This module produces exactly that and nothing else.
 *
 * ## Why it is deliberately small
 *
 * The full git surface lives in `src/git/`, which pulls `isomorphic-git` and a
 * `VirtualFS`. The previewer needs two reads (resolve HEAD, read one blob) and
 * runs in the UI layer, where dragging in the whole git stack would cost every
 * user who never opens a preview. So `isomorphic-git` is imported LAZILY, on the
 * first preview of a file that turns out to live in a repo, and the filesystem
 * shim exposes only the handful of operations those two reads touch.
 *
 * ## Failure is not exceptional here
 *
 * Most files are not in a repo, and of those that are, most are unmodified.
 * Every path through this module therefore treats "no diff available" as an
 * ordinary answer (`null`), never an error: a file with no git history simply
 * previews as a file.
 */

import type { LocalVfsClient } from '../kernel/local-vfs-client.js';

/** The committed side of a modified file. */
export interface GitPreviewBase {
  /** Contents of the file at HEAD. */
  baseContent: string;
  /** Short label for the header chip. */
  status: 'modified';
  /** Absolute path of the repository root. */
  repoRoot: string;
}

/** How far up the tree to look for a `.git` before giving up. */
const MAX_ASCENT = 24;

/**
 * The repository root containing `path`, or `null` when it is not in a repo.
 *
 * Walks up looking for a `.git` entry. `.git` is accepted whether it is a
 * directory or a file, since a worktree or submodule records a gitdir pointer
 * as a plain file.
 */
export async function findRepoRoot(fs: LocalVfsClient, path: string): Promise<string | null> {
  let dir = path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '/';

  for (let hops = 0; hops < MAX_ASCENT; hops += 1) {
    try {
      await fs.stat(dir === '/' ? '/.git' : `${dir}/.git`);
      return dir === '' ? '/' : dir;
    } catch {
      // not here — keep climbing
    }
    if (dir === '/' || dir === '') return null;
    dir = dir.slice(0, Math.max(dir.lastIndexOf('/'), 0)) || '/';
  }
  return null;
}

/** Node-shaped stats, the subset `isomorphic-git` actually reads. */
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

/**
 * The read half of `isomorphic-git`'s `PromiseFsClient`.
 *
 * Spelled out rather than typed as a string-keyed bag so the shape is checked:
 * a typo in a method name would otherwise surface as an opaque runtime failure
 * inside the git internals.
 */
interface ReadOnlyGitFs {
  promises: {
    readFile(path: string, options?: { encoding?: string } | string): Promise<string | Uint8Array>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<GitStats>;
    lstat(path: string): Promise<GitStats>;
    readlink(path: string): Promise<string>;
  };
}

/**
 * A read-only `isomorphic-git` filesystem over the panel's VFS client.
 *
 * `resolveRef` + `readBlob` only ever read, so the write half of the interface
 * is intentionally absent: if a future change starts calling one, it fails loudly
 * here rather than silently corrupting a repo through a preview surface.
 */
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

/**
 * Read the HEAD version of `path`, when it is tracked and differs from `current`.
 *
 * Returns `null` — never throws — when the file is untracked, unmodified, not in
 * a repo, or the repo cannot be read.
 */
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

    // An unmodified file has nothing to diff — previewing it as a no-op diff
    // would be worse than previewing the file.
    if (baseContent === current) return null;

    return { baseContent, status: 'modified', repoRoot };
  } catch {
    return null; // untracked, empty repo, unreadable objects — all just "no diff"
  }
}
