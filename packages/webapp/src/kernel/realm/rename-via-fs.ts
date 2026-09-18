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
  } catch {}
  const content = await fs.readFileBuffer(src);
  await fs.writeFile(dest, content);
  await fs.rm(src, { recursive: true });
}
