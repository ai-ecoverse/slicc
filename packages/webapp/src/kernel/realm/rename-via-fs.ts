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
 * and the destination's directory must exist, and a directory is not copied
 * (EXDEV, or the native rename's own error).
 */

export interface RenameFs {
  rename?: (a: string, b: string) => Promise<void>;
  mv?: (a: string, b: string) => Promise<void>;
  stat: (path: string) => Promise<{ identity?: string; isDirectory?: boolean }>;
  readFileBuffer: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, content: Uint8Array | string) => Promise<void>;
  rm: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
}

/** An error carrying a POSIX errno name, as the bridges report it. */
function posixError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** The native rename's own error, if it had one, else `code`. */
function nativeOr(native: unknown, code: string, message: string): unknown {
  return native ?? posixError(code, message);
}

/**
 * The native rename, or mv: undefined when one renamed, else the first error
 * (or null when the handle has neither). Called on `fs`: a VirtualFS method
 * needs its `this`.
 */
async function nativeRename(fs: RenameFs, src: string, dest: string): Promise<unknown> {
  let first: unknown = null;
  for (const fn of [fs.rename, fs.mv]) {
    if (!fn) continue;
    try {
      await fn.call(fs, src, dest);
      return undefined;
    } catch (err) {
      // VirtualFS.rename on a picker/S3/DA/AEM mount has no native rename and
      // LightningFS cannot see the subtree — the historical contract is
      // "throw, caller copy+deletes". Kept, to report if the copy may not run.
      first ??= err;
    }
  }
  return first;
}

function parentOf(path: string): string {
  const slash = path.replace(/\/+$/, '').lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

export async function renameViaFs(fs: RenameFs, src: string, dest: string): Promise<void> {
  if (src === dest) return;
  const native = await nativeRename(fs, src, dest);
  if (native === undefined) return;
  // The copy stands in for rename(2), so it keeps its contract: a missing
  // source or destination directory fails it, instead of the copy creating
  // the parent — and a directory is never read as a file (that wrote an
  // empty file in its place, then removed the tree).
  const fromStat = await fs.stat(src);
  let parent: { isDirectory?: boolean };
  try {
    parent = await fs.stat(parentOf(dest));
  } catch {
    throw nativeOr(native, 'ENOENT', `no such directory for ${dest}`);
  }
  if (parent.isDirectory === false) {
    throw nativeOr(native, 'ENOTDIR', `not a directory: ${parentOf(dest)}`);
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
  try {
    const toStat = await fs.stat(dest);
    if (fromStat.identity && fromStat.identity === toStat.identity) return;
  } catch {
    /* dest missing — a plain copy */
  }
  const content = await fs.readFileBuffer(src);
  await fs.writeFile(dest, content);
  await fs.rm(src, { recursive: true });
}
