import { resolveSyncFsToken } from './sync-fs-token-registry.js';

export type SyncFsOp =
  | 'read'
  | 'write'
  | 'exists'
  | 'stat'
  | 'lstat'
  | 'readdir'
  | 'mkdir'
  | 'rm'
  | 'rename';

export interface SyncFsRequest {
  token: string;
  op: SyncFsOp;
  path: string;

  body?: Uint8Array;

  arg2?: string;
}

export type SyncFsResult =
  | { ok: true; kind: 'bytes'; bytes: Uint8Array }
  | { ok: true; kind: 'json'; json: unknown }
  | { ok: true; kind: 'void' }
  | { ok: false; errno: string; message: string };

export function toErrno(err: unknown): SyncFsResult {
  const message = err instanceof Error ? err.message : String(err);

  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    return { ok: false, errno: code, message };
  }
  return { ok: false, errno: 'EIO', message };
}

export async function dispatchSyncFs(req: SyncFsRequest): Promise<SyncFsResult> {
  const entry = resolveSyncFsToken(req.token);
  if (!entry) {
    return { ok: false, errno: 'EACCES', message: 'sync-fs: unknown or revoked token' };
  }
  const { fs, cwd } = entry;
  try {
    const resolved = fs.resolvePath(cwd, req.path);
    switch (req.op) {
      case 'read':
        return { ok: true, kind: 'bytes', bytes: await fs.readFileBuffer(resolved) };
      case 'write':
        await fs.writeFile(resolved, req.body ?? new Uint8Array(0));
        return { ok: true, kind: 'void' };
      case 'exists':
        return { ok: true, kind: 'json', json: await fs.exists(resolved) };
      case 'stat': {
        const s = await fs.stat(resolved);
        return {
          ok: true,
          kind: 'json',
          json: {
            isDirectory: s.isDirectory,
            isFile: s.isFile,
            isSymbolicLink: s.isSymbolicLink,
            size: s.size,
          },
        };
      }
      case 'lstat': {
        const s = await fs.lstat(resolved);
        return {
          ok: true,
          kind: 'json',
          json: {
            isDirectory: s.isDirectory,
            isFile: s.isFile,
            isSymbolicLink: s.isSymbolicLink ?? false,
            size: s.size,
          },
        };
      }
      case 'readdir':
        return { ok: true, kind: 'json', json: await fs.readdir(resolved) };
      case 'mkdir':
        await fs.mkdir(resolved, { recursive: true });
        return { ok: true, kind: 'void' };
      case 'rm':
        await fs.rm(resolved, { recursive: true });
        return { ok: true, kind: 'void' };
      case 'rename': {
        const dest = fs.resolvePath(cwd, req.arg2 ?? '');
        const maybe = fs as {
          rename?: (a: string, b: string) => Promise<void>;
          mv?: (a: string, b: string) => Promise<void>;
        };
        if (maybe.rename) {
          await maybe.rename(resolved, dest);
        } else if (maybe.mv) {
          await maybe.mv(resolved, dest);
        } else {
          const content = await fs.readFileBuffer(resolved);
          await fs.writeFile(dest, content);
          await fs.rm(resolved, { recursive: true });
        }
        return { ok: true, kind: 'void' };
      }
      default:
        return { ok: false, errno: 'EINVAL', message: `sync-fs: unknown op '${req.op as string}'` };
    }
  } catch (err) {
    return toErrno(err);
  }
}
