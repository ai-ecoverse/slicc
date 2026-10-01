/**
 * Rename through a realm `ctx.fs` handle without the copy-then-unlink
 * truncation that hits when dest is the same inode as source.
 *
 * Production `ctx.fs` is a `VfsAdapter` (possibly sudo-wrapped): it exposes
 * `mv`, not `rename`. Probe both; if they throw (picker/S3/DA/AEM have no
 * native rename) fall back to copy+remove. Never copy+remove when the two
 * paths already name one file.
 *
 * The source is fully read before dest is opened. Opening dest first with
 * O_TRUNC on a case-/NFC-equal name zeros the only copy (#3107).
 *
 * The copy only stands in where rename(2) would have succeeded: the source
 * and the destination's directory must exist (ENOENT / ENOTDIR), and a
 * directory is not copied (EXDEV, or the native rename's own error).
 */

export interface RenameFs {
  rename?: (a: string, b: string) => Promise<void>;
  mv?: (a: string, b: string) => Promise<void>;
  stat: (path: string) => Promise<{ identity?: string; isDirectory?: boolean }>;
  /** The entry itself, a symlink not followed (without one, `stat`). */
  lstat?: (path: string) => Promise<{ isDirectory?: boolean; isSymbolicLink?: boolean }>;
  readFileBuffer: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, content: Uint8Array | string) => Promise<void>;
  rm: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
}

/** An error carrying a POSIX errno name, as the bridges report it. */
function posixError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * The native rename (or, without one, mv): undefined when it renamed, else
 * its error (null when the handle has neither). Called once: VfsAdapter's
 * `rename` is its `mv`, and a retry after a throw that already moved the
 * entry (a persist failing after the store renamed) would hide that error.
 * Called on `fs`: a VirtualFS method needs its `this`.
 */
async function nativeRename(fs: RenameFs, src: string, dest: string): Promise<unknown> {
  const fn = fs.rename ?? fs.mv;
  if (!fn) return null;
  try {
    await fn.call(fs, src, dest);
    return undefined;
  } catch (err) {
    // VirtualFS.rename on a picker/S3/DA/AEM mount has no native rename and
    // LightningFS cannot see the subtree — the historical contract is
    // "throw, caller copy+deletes". Kept, to report if the copy may not run.
    return err;
  }
}

function parentOf(path: string): string {
  const slash = path.replace(/\/+$/, '').lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

/** `path`'s stat (its lstat with `entry`), or undefined when it does not exist; other errors propagate. */
async function statIfPresent(
  fs: RenameFs,
  path: string,
  entry: boolean
): Promise<{ identity?: string; isDirectory?: boolean; isSymbolicLink?: boolean } | undefined> {
  try {
    return entry && fs.lstat ? await fs.lstat(path) : await fs.stat(path);
  } catch (err) {
    // Only ENOENT says it is absent; an EIO or a denied lookup says so.
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function renameViaFs(fs: RenameFs, src: string, dest: string): Promise<void> {
  if (src === dest) return;
  const native = await nativeRename(fs, src, dest);
  if (native === undefined) return;
  // The copy stands in for rename(2), so it keeps its contract: a missing
  // source or destination directory fails it, instead of the copy creating
  // the parent — and a directory is never read as a file (that wrote an
  // empty file in its place, then removed the tree). A cause proven here is
  // reported as itself, whatever the native rename said (a backend that
  // cannot see a mount answers ENOENT for everything).
  const fromStat = await fs.stat(src);
  let parent: { isDirectory?: boolean };
  try {
    parent = await fs.stat(parentOf(dest));
  } catch (err) {
    // Only a missing directory is ENOENT; an EIO or a denied lookup says so.
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err;
    throw posixError('ENOENT', `no such directory for ${dest}`);
  }
  if (parent.isDirectory === false) {
    throw posixError('ENOTDIR', `not a directory: ${parentOf(dest)}`);
  }
  if (fromStat.isDirectory) {
    // A directory is not copied. The native rename's own verdict stands
    // (ENOTEMPTY, EINVAL, …), except an ENOENT for paths that both exist —
    // a backend that cannot see them: EXDEV, so the caller copies the tree
    // (mv, shutil.move) if it wants to.
    const code = (native as { code?: unknown } | null)?.code;
    if (native && code !== 'ENOENT') throw native;
    throw posixError('EXDEV', `cannot move directory ${src} to ${dest}`);
  }
  const toStat = await statIfPresent(fs, dest, false);
  if (toStat && fromStat.identity && fromStat.identity === toStat.identity) return;
  // The destination entry itself: a symlink is replaced (even one to a
  // directory), a directory is not — the copy's writeFile would fail on it
  // unseen, and the source would then be removed with nothing written.
  const toEntry = fs.lstat ? await statIfPresent(fs, dest, true) : toStat;
  if (toEntry?.isDirectory) throw posixError('EISDIR', `is a directory: ${dest}`);
  const content = await fs.readFileBuffer(src);
  // writeFile would follow the link: the link goes, the file takes its place.
  if (toEntry?.isSymbolicLink) await fs.rm(dest);
  await fs.writeFile(dest, content);
  await fs.rm(src, { recursive: true });
}
