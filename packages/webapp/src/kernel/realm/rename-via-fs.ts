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
 */

export interface RenameFs {
  rename?: (a: string, b: string) => Promise<void>;
  mv?: (a: string, b: string) => Promise<void>;
  stat: (path: string) => Promise<{ identity?: string }>;
  readFileBuffer: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, content: Uint8Array | string) => Promise<void>;
  rm: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
}

async function tryNativeRename(
  fn: ((a: string, b: string) => Promise<void>) | undefined,
  src: string,
  dest: string
): Promise<boolean> {
  if (!fn) return false;
  try {
    await fn(src, dest);
    return true;
  } catch {
    // VirtualFS.rename on a picker/S3/DA/AEM mount has no native rename and
    // LightningFS cannot see the subtree — the historical contract is "throw,
    // caller copy+deletes". Swallow and fall through.
    return false;
  }
}

export async function renameViaFs(fs: RenameFs, src: string, dest: string): Promise<void> {
  if (src === dest) return;
  if (await tryNativeRename(fs.rename, src, dest)) return;
  if (await tryNativeRename(fs.mv, src, dest)) return;
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
