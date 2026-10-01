export interface RenameFs {
  rename?: (a: string, b: string) => Promise<void>;
  mv?: (a: string, b: string) => Promise<void>;
  stat: (path: string) => Promise<{ identity?: string; isDirectory?: boolean }>;
  readFileBuffer: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, content: Uint8Array | string) => Promise<void>;
  rm: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
}

function posixError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

async function nativeRename(fs: RenameFs, src: string, dest: string): Promise<unknown> {
  const fn = fs.rename ?? fs.mv;
  if (!fn) return null;
  try {
    await fn.call(fs, src, dest);
    return undefined;
  } catch (err) {
    return err;
  }
}

function parentOf(path: string): string {
  const slash = path.replace(/\/+$/, '').lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

export async function renameViaFs(fs: RenameFs, src: string, dest: string): Promise<void> {
  if (src === dest) return;
  const native = await nativeRename(fs, src, dest);
  if (native === undefined) return;

  const fromStat = await fs.stat(src);
  let parent: { isDirectory?: boolean };
  try {
    parent = await fs.stat(parentOf(dest));
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err;
    throw posixError('ENOENT', `no such directory for ${dest}`);
  }
  if (parent.isDirectory === false) {
    throw posixError('ENOTDIR', `not a directory: ${parentOf(dest)}`);
  }
  if (fromStat.isDirectory) {
    const code = (native as { code?: unknown } | null)?.code;
    if (native && code !== 'ENOENT') throw native;
    throw posixError('EXDEV', `cannot move directory ${src} to ${dest}`);
  }
  try {
    const toStat = await fs.stat(dest);
    if (fromStat.identity && fromStat.identity === toStat.identity) return;
  } catch {}
  const content = await fs.readFileBuffer(src);
  await fs.writeFile(dest, content);
  await fs.rm(src, { recursive: true });
}
