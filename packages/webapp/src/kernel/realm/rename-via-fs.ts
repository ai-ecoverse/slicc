/**
 * Rename through a realm `ctx.fs` handle without the copy-then-unlink
 * truncation that hits when dest is the same inode as source.
 *
 * Production `ctx.fs` is a `VfsAdapter` (possibly sudo-wrapped): it exposes
 * `mv`, not `rename`. Probe both, then fall back to copy+remove only when
 * neither is present — and never when the two paths already name one file.
 *
 * The source is fully read before dest is opened. Opening dest first with
 * O_TRUNC on a case-/NFC-equal name zeros the only copy (#3107).
 */

export interface RenameFs {
  rename?: (a: string, b: string) => Promise<void>;
  mv?: (a: string, b: string) => Promise<void>;
  stat: (path: string) => Promise<{ identity?: string }>;
  readFileBuffer: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, content: Uint8Array | string) => Promise<void>;
  rm: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
}

export async function renameViaFs(fs: RenameFs, src: string, dest: string): Promise<void> {
  if (src === dest) return;
  if (fs.rename) {
    await fs.rename(src, dest);
    return;
  }
  if (fs.mv) {
    await fs.mv(src, dest);
    return;
  }
  try {
    const [fromStat, toStat] = await Promise.all([fs.stat(src), fs.stat(dest)]);
    if (fromStat.identity && fromStat.identity === toStat.identity) return;
  } catch {
    /* dest missing, or source missing — readFileBuffer throws ENOENT */
  }
  const content = await fs.readFileBuffer(src);
  await fs.writeFile(dest, content);
  await fs.rm(src, { recursive: true });
}
